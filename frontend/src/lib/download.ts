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

import { blobToBytes } from "./chunker";

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

/** A single received file to include in a multi-file ZIP download. */
export interface BundleItem {
  blob: Blob;
  name: string;
}

export type SaveAllResult = "shared" | "downloaded" | "cancelled";

/** Classic (non-ZIP64) ZIP hard limits: u16 entry count, u32 sizes/offsets. */
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_TOTAL_BYTES = 0xffffffff;
/** Generous per-entry bound for local+central headers and the entry name. */
const ZIP_ENTRY_OVERHEAD = 30 + 46 + 512;

/**
 * Would a bundle of these file sizes overflow the classic ZIP format? Our
 * writer has no ZIP64 support, so past 4 GiB total (or 65,535 entries) the
 * u32/u16 header fields would silently wrap and produce a CORRUPT archive.
 * Pure + exported for unit testing.
 */
export function exceedsZipLimits(sizes: number[]): boolean {
  if (sizes.length > ZIP_MAX_ENTRIES) return true;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total + sizes.length * ZIP_ENTRY_OVERHEAD + 22 > ZIP_MAX_TOTAL_BYTES;
}

interface ZipSourceEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  localOffset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sanitizeEntryName(name: string): string {
  const basename = (name || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() ?? "";
  const stripped = basename
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return stripped || "file";
}

function uniqueEntryName(name: string, used: Map<string, number>): string {
  const key = name.toLowerCase();
  const count = used.get(key) ?? 0;
  used.set(key, count + 1);
  if (count === 0) return name;

  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${name.slice(0, dot)} (${count})${name.slice(dot)}`;
  }
  return `${name} (${count})`;
}

function zipArchiveName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `securesend-${stamp}.zip`;
}

function buildStoredZip(entries: ZipSourceEntry[]): Uint8Array {
  const encodedNames = entries.map((entry) => encodeUtf8(entry.name));
  const localSize = entries.reduce(
    (sum, entry, i) => sum + 30 + encodedNames[i].byteLength + entry.data.byteLength,
    0,
  );
  const centralSize = entries.reduce(
    (sum, _entry, i) => sum + 46 + encodedNames[i].byteLength,
    0,
  );
  const out = new Uint8Array(localSize + centralSize + 22);
  let offset = 0;

  entries.forEach((entry, i) => {
    entry.localOffset = offset;
    const name = encodedNames[i];
    writeU32(out, offset, 0x04034b50);
    writeU16(out, offset + 4, 20);
    writeU16(out, offset + 6, 0x0800);
    writeU16(out, offset + 8, 0);
    writeU16(out, offset + 10, 0);
    writeU16(out, offset + 12, 0);
    writeU32(out, offset + 14, entry.crc);
    writeU32(out, offset + 18, entry.data.byteLength);
    writeU32(out, offset + 22, entry.data.byteLength);
    writeU16(out, offset + 26, name.byteLength);
    writeU16(out, offset + 28, 0);
    out.set(name, offset + 30);
    out.set(entry.data, offset + 30 + name.byteLength);
    offset += 30 + name.byteLength + entry.data.byteLength;
  });

  const centralOffset = offset;
  entries.forEach((entry, i) => {
    const name = encodedNames[i];
    writeU32(out, offset, 0x02014b50);
    writeU16(out, offset + 4, 20);
    writeU16(out, offset + 6, 20);
    writeU16(out, offset + 8, 0x0800);
    writeU16(out, offset + 10, 0);
    writeU16(out, offset + 12, 0);
    writeU16(out, offset + 14, 0);
    writeU32(out, offset + 16, entry.crc);
    writeU32(out, offset + 20, entry.data.byteLength);
    writeU32(out, offset + 24, entry.data.byteLength);
    writeU16(out, offset + 28, name.byteLength);
    writeU16(out, offset + 30, 0);
    writeU16(out, offset + 32, 0);
    writeU16(out, offset + 34, 0);
    writeU16(out, offset + 36, 0);
    writeU32(out, offset + 38, 0);
    writeU32(out, offset + 42, entry.localOffset);
    out.set(name, offset + 46);
    offset += 46 + name.byteLength;
  });

  writeU32(out, offset, 0x06054b50);
  writeU16(out, offset + 4, 0);
  writeU16(out, offset + 6, 0);
  writeU16(out, offset + 8, entries.length);
  writeU16(out, offset + 10, entries.length);
  writeU32(out, offset + 12, centralSize);
  writeU32(out, offset + 16, centralOffset);
  writeU16(out, offset + 20, 0);

  return out;
}

/** Build a standards-compliant ZIP File from already-decrypted in-memory blobs. */
export async function buildZipFile(
  items: BundleItem[],
  zipName: string,
): Promise<File> {
  // Defense-in-depth: refuse to emit an archive that would overflow the
  // classic ZIP header fields (callers should check exceedsZipLimits first).
  if (exceedsZipLimits(items.map((item) => item.blob.size))) {
    throw new Error(
      "This bundle is too large for a single ZIP (4 GiB / 65,535 file limit).",
    );
  }

  const used = new Map<string, number>();
  const entries: ZipSourceEntry[] = [];

  for (const item of items) {
    const data = await blobToBytes(item.blob);
    entries.push({
      name: uniqueEntryName(sanitizeEntryName(item.name), used),
      data,
      crc: crc32(data),
      localOffset: 0,
    });
  }

  const zipBytes = buildStoredZip(entries);
  return new File([exactArrayBuffer(zipBytes)], zipName || "securesend.zip", {
    type: "application/zip",
  });
}

/**
 * Save several received files as one ZIP. Uses the native share sheet where it
 * supports files (notably useful on iOS/iPadOS), with a normal download as the
 * universal fallback.
 *
 * Bundles past the classic ZIP format's limits (4 GiB total / 65,535 entries)
 * can't be archived by our writer, so they're saved as individual downloads
 * instead of failing — or worse, silently producing a corrupt ZIP.
 */
export async function saveAllAsZip(items: BundleItem[]): Promise<SaveAllResult> {
  if (exceedsZipLimits(items.map((item) => item.blob.size))) {
    for (let i = 0; i < items.length; i += 1) {
      downloadBlob(items[i].blob, items[i].name);
      // Small gap so browsers don't swallow back-to-back downloads.
      if (i < items.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    return "downloaded";
  }

  const zip = await buildZipFile(items, zipArchiveName());
  if (canShareFile(zip)) {
    const result = await shareFile(zip);
    if (result === "shared") return "shared";
    if (result === "cancelled") return "cancelled";
  }
  downloadBlob(zip, zip.name);
  return "downloaded";
}
