/**
 * download.ts — saving received files to the user's device.
 *
 * Two paths:
 *   1. Web Share API (`navigator.share` with files) — on iOS/iPadOS this opens
 *      the native share sheet, which for an image offers "Save Image" → Photos
 *      (and "Save Video" for videos). This is the ONLY way a web app can place
 *      media into the iOS Photos library; a plain download always goes to Files.
 *   2. Classic anchor download — universal fallback (desktop, Android, and iOS
 *      when sharing is unavailable or declined). Lands in the Downloads/Files.
 *
 * All of this happens locally on the already-decrypted Blob. Nothing here
 * touches the network.
 */

import { buildZip, type ZipEntry } from "./zip";

/** True for image MIME types (jpeg/png/gif/webp/heic/…). */
export function isImage(mime: string): boolean {
  return /^image\//i.test(mime);
}

/** True for video MIME types. */
export function isVideo(mime: string): boolean {
  return /^video\//i.test(mime);
}

/** Wrap a decrypted Blob in a named File with the correct MIME type. */
export function buildFile(blob: Blob, name: string, mime: string): File {
  const type = mime || blob.type || "application/octet-stream";
  return new File([blob], name || "download", { type });
}

/** Turn a text snippet into a downloadable .txt File for sending. */
export function textToFile(text: string): File {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new File([text], `securesend-message-${stamp}.txt`, {
    type: "text/plain",
  });
}

/** Soft warning threshold for in-memory reassembly on the receiver (1.5 GB). */
export const LARGE_FILE_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Can this file be shared via the native share sheet? Guards `canShare` with a
 * try/catch because some browsers throw on unsupported descriptors.
 */
export function canShareFile(file: File): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      typeof navigator.share === "function" &&
      navigator.canShare({ files: [file] })
    );
  } catch {
    return false;
  }
}

export type ShareResult = "shared" | "cancelled" | "unsupported" | "failed";

/**
 * Offer the file through the native share sheet. Must be called from a user
 * gesture (tap/click). Distinguishes a user cancel (AbortError) from a real
 * failure so callers can decide whether to fall back to a download.
 */
export async function shareFile(file: File): Promise<ShareResult> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return "unsupported";
  }
  try {
    await navigator.share({ files: [file], title: file.name });
    return "shared";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return "cancelled";
    }
    return "failed";
  }
}

/**
 * Save a Blob to disk via a synthetic anchor click. Works without depending on
 * React render timing, so the first click always produces a save prompt.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a delay so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** A single file to include in a multi-file ZIP download. */
export interface BundleItem {
  blob: Blob;
  name: string;
}

/** Outcome of {@link saveAllAsZip}. */
export type SaveAllResult = "shared" | "downloaded" | "cancelled";

/**
 * Make a ZIP entry name safe: drop directory separators (no path traversal),
 * strip control characters and leading dots, and fall back to a default.
 */
function sanitizeEntryName(name: string): string {
  let out = "";
  for (const ch of name || "") {
    const code = ch.charCodeAt(0);
    if (code < 0x20) continue; // strip control characters
    out += ch === "/" || ch === "\\" ? "_" : ch;
  }
  out = out.replace(/^\.+/, "").trim();
  return out || "file";
}

/**
 * Ensure a name is unique within the archive by appending " (n)" before the
 * extension on collisions (case-insensitive, mirroring how OSes de-dupe names).
 */
function uniqueName(name: string, used: Map<string, number>): string {
  const key = name.toLowerCase();
  const count = used.get(key) ?? 0;
  used.set(key, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${count})${name.slice(dot)}`
    : `${name} (${count})`;
}

/**
 * Read every blob into memory and bundle them into a single ZIP File. Exposed
 * for testing; most callers want {@link saveAllAsZip}.
 */
export async function buildZipFile(
  items: BundleItem[],
  zipName: string,
): Promise<File> {
  const used = new Map<string, number>();
  const entries: ZipEntry[] = [];
  for (const item of items) {
    const name = uniqueName(sanitizeEntryName(item.name), used);
    const data = new Uint8Array(await item.blob.arrayBuffer());
    entries.push({ name, data });
  }
  return new File([buildZip(entries)], zipName, { type: "application/zip" });
}

/** Timestamped archive name, e.g. securesend-2026-06-05-17-07-20.zip */
function zipArchiveName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `securesend-${stamp}.zip`;
}

/**
 * Bundle several received files into one ZIP and hand it to the user.
 *
 * Saving works on every platform with a single user gesture:
 *   - Where the native share sheet can take the file (notably iOS/iPadOS), we
 *     offer it first so the user gets "Save to Files", AirDrop, etc. This is
 *     the reliable iOS path — sequential downloads are blocked there.
 *   - Otherwise (desktop, Android) we fall back to a classic anchor download,
 *     which is also used if the share sheet reports unsupported/failed.
 *
 * Must be invoked from a user gesture (tap/click).
 */
export async function saveAllAsZip(items: BundleItem[]): Promise<SaveAllResult> {
  const zip = await buildZipFile(items, zipArchiveName());
  if (canShareFile(zip)) {
    const result = await shareFile(zip);
    if (result === "shared") return "shared";
    if (result === "cancelled") return "cancelled";
    // "unsupported" / "failed" → fall through to a plain download.
  }
  downloadBlob(zip, zip.name);
  return "downloaded";
}
