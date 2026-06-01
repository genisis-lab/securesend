/**
 * chunker.ts — file chunking + encrypted-chunk wire framing.
 *
 * Wire format for a transferred encrypted chunk (all little-endian):
 *
 *   ┌────────────┬──────────────┬───────────────────────────┐
 *   │  IV (12B)  │ chunkIndex   │  ciphertext (variable)     │
 *   │            │ (4B uint32)  │  (AES-GCM ct + 16B tag)    │
 *   └────────────┴──────────────┴───────────────────────────┘
 *
 * The chunkIndex is included BOTH in the frame header (so the receiver can
 * reorder / detect gaps) AND inside the AES-GCM AAD (so it is authenticated
 * and cannot be altered without failing decryption).
 *
 * Per-transfer metadata (filename, size, mime, totalChunks) is sent once as an
 * authenticated metadata message before the chunks; its fields are folded into
 * each chunk's AAD via a transfer-id binding so a tampered metadata header is
 * detectable.
 */

import { IV_LENGTH } from "./crypto";

/** Default plaintext chunk size: 64 KiB. Tunable for throughput vs memory. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** AES-GCM authentication tag length in bytes. */
export const GCM_TAG_BYTES = 16;

/** Authenticated metadata describing the file being transferred. */
export interface FileMetadata {
  /** Original filename. Authenticated, never logged in production. */
  name: string;
  /** Total file size in bytes. */
  size: number;
  /** MIME type (may be empty string). */
  mime: string;
  /** Total number of chunks the file is split into. */
  totalChunks: number;
  /** Plaintext chunk size used by the sender. */
  chunkSize: number;
  /**
   * Random transfer id (base64url). Binds all chunks to this metadata so the
   * AAD of every chunk authenticates the metadata indirectly.
   */
  transferId: string;
}

/** Number of chunks required for a given byte length. */
export function chunkCount(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

/**
 * Build the Additional Authenticated Data (AAD) for a chunk.
 *
 * AAD = UTF8( transferId | ":" | chunkIndex | ":" | totalChunks | ":" |
 *             size | ":" | mime | ":" | name )
 *
 * Because AES-GCM verifies AAD on decrypt, any tampering with the chunk index
 * or with the bound metadata causes decryption to throw. This authenticates
 * filename, size, MIME type, and chunk ordering.
 */
export function buildChunkAAD(meta: FileMetadata, chunkIndex: number): Uint8Array {
  const aadString = [
    meta.transferId,
    chunkIndex,
    meta.totalChunks,
    meta.size,
    meta.mime,
    meta.name,
  ].join(":");
  return new TextEncoder().encode(aadString);
}

/** Pack an encrypted frame: [IV][chunkIndex u32][ciphertext]. */
export function packFrame(
  iv: Uint8Array,
  chunkIndex: number,
  ciphertext: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(IV_LENGTH + 4 + ciphertext.length);
  frame.set(iv, 0);
  const dv = new DataView(frame.buffer);
  dv.setUint32(IV_LENGTH, chunkIndex, true /* little-endian */);
  frame.set(ciphertext, IV_LENGTH + 4);
  return frame;
}

export interface UnpackedFrame {
  iv: Uint8Array;
  chunkIndex: number;
  ciphertext: Uint8Array;
}

/** Parse a received frame back into IV, chunk index, and ciphertext. */
export function unpackFrame(frame: Uint8Array): UnpackedFrame {
  if (frame.length < IV_LENGTH + 4 + GCM_TAG_BYTES) {
    throw new Error("Frame too short to be a valid encrypted chunk");
  }
  const iv = frame.subarray(0, IV_LENGTH);
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const chunkIndex = dv.getUint32(IV_LENGTH, true);
  const ciphertext = frame.subarray(IV_LENGTH + 4);
  return { iv, chunkIndex, ciphertext };
}

/**
 * Async generator that yields plaintext chunks from a File/Blob without
 * loading the whole file into memory. Uses Blob.slice + a robust byte reader.
 */
export async function* readFileChunks(
  file: Blob,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const total = chunkCount(file.size, chunkSize);
  for (let index = 0; index < total; index++) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const slice = file.slice(start, end);
    const data = await blobToBytes(slice);
    yield { index, data };
  }
}

/**
 * Read a Blob into a Uint8Array. Prefers the modern `Blob.arrayBuffer()` API
 * available in all WebRTC-capable browsers, and falls back to FileReader for
 * environments (e.g. jsdom under test) whose sliced Blobs lack arrayBuffer().
 */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== "undefined") {
    return new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsArrayBuffer(blob);
    });
  }
  // Last-resort fallback via the Fetch Response API.
  return new Uint8Array(await new Response(blob).arrayBuffer());
}
