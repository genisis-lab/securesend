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
  return canShareFiles([file]);
}

/** Can this set of files be shared together via the native share sheet? */
export function canShareFiles(files: File[]): boolean {
  if (files.length === 0) return false;
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      typeof navigator.share === "function" &&
      navigator.canShare({ files })
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
  return shareFiles([file], file.name);
}

/** Offer multiple files together through the native share sheet. */
export async function shareFiles(files: File[], title = "SecureSend files"): Promise<ShareResult> {
  if (
    files.length === 0 ||
    typeof navigator === "undefined" ||
    typeof navigator.share !== "function"
  ) {
    return "unsupported";
  }
  try {
    await navigator.share({ files, title });
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

/** Download several files one-by-one using the universal anchor fallback. */
export function downloadBlobs(files: File[]): void {
  files.forEach((file, index) => {
    // Small stagger helps mobile/desktop browsers register each download.
    setTimeout(() => downloadBlob(file, file.name), index * 250);
  });
}
