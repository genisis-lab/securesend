/**
 * store-transfer.ts — OPTIONAL store-and-forward transfer via Cloudflare R2.
 *
 * Unlike the live P2P path, here the recipient need NOT be online. The sender:
 *   1. derives an AES key from the link secret (+ optional passphrase) — NO ECDH,
 *   2. encrypts each file into chunk frames and concatenates them into one blob,
 *   3. encrypts a manifest (file names/sizes/mime/chunking) describing the blob,
 *   4. uploads ciphertext + encrypted manifest to the Worker (R2).
 * The sender can then close the tab. The recipient later:
 *   1. fetches the encrypted manifest + ciphertext,
 *   2. derives the same key from the link fragment, decrypts, reassembles.
 *
 * The server stores ONLY ciphertext and never sees the key.
 *
 * Blob layout (plaintext, before encryption is per-chunk as usual):
 *   For file f, chunk c: frame = [IV(12)][chunkIndex u32][AES-GCM ciphertext]
 *   Frames for all files are concatenated in manifest order. The manifest lists
 *   each file's transferId, size, mime, totalChunks, chunkSize and the byte
 *   offset/length of its frame region within the blob.
 */

import {
  decryptChunk,
  deriveStoredAesKey,
  encryptChunk,
  generateIV,
  randomBytes,
  bytesToBase64,
  base64ToBytes,
  toArrayBuffer,
} from "./crypto";
import {
  buildChunkAAD,
  DEFAULT_CHUNK_SIZE,
  FileMetadata,
  packFrame,
  readFileChunks,
  unpackFrame,
  GCM_TAG_BYTES,
} from "./chunker";
import { IV_LENGTH } from "./crypto";
import { ReceivedItem, TransferProgress } from "./transfer";
import { SIGNAL_URL } from "./config";
import { createFileSink, canStreamToDisk } from "./file-sink";
import { buildFrameSchedule, StreamDeframer } from "./deframer";

/** Per-file entry in the (encrypted) manifest. */
interface ManifestEntry extends FileMetadata {
  /** Byte offset of this file's frame region within the combined blob. */
  byteOffset: number;
  /** Byte length of this file's frame region. */
  byteLength: number;
}

interface Manifest {
  version: 1;
  files: ManifestEntry[];
}

function httpBase(): string {
  return SIGNAL_URL.replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
}

/**
 * Translate a raw fetch/stream failure into a user-facing Error. Browsers
 * reject failed fetches with cryptic TypeErrors (Safari: "Load failed",
 * Chrome: "Failed to fetch") that mean nothing to users; aborts keep their
 * "cancelled" semantics so callers can distinguish a user cancel.
 */
function friendlyNetworkError(err: unknown): Error {
  if (err instanceof DOMException && err.name === "AbortError") {
    return new Error("cancelled");
  }
  if (err instanceof TypeError) {
    return new Error(
      "Can't reach the SecureSend server. Check your internet connection and try again.",
    );
  }
  return err instanceof Error ? err : new Error("Network request failed");
}

/** fetch() wrapper that converts low-level network failures into clear errors. */
async function fetchSafe(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    throw friendlyNetworkError(err);
  }
}

function randomTransferId(): string {
  const b = randomBytes(9);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Frame size for a chunk of plaintext length n. */
function frameSize(n: number): number {
  return IV_LENGTH + 4 + n + GCM_TAG_BYTES;
}

export interface StoreUploadResult {
  /** Storage id to embed in the invite link. */
  id: string;
  /** Server-reported expiry (epoch ms). */
  expiresAt: number;
}

/**
 * Encrypt the given files with a key derived from `linkSecret` (+ passphrase)
 * and upload the ciphertext to R2 using MULTIPART upload (no size limit). The
 * encrypted manifest is sent with the completion request.
 *
 * Encryption streams chunk-by-chunk into ~PART_SIZE buffers; each filled buffer
 * is uploaded as a multipart part, so peak memory stays bounded regardless of
 * total file size.
 */
export async function uploadStored(opts: {
  files: File[];
  linkSecret: string;
  passphrase?: string;
  salt: Uint8Array;
  burn?: boolean;
  onProgress: (p: TransferProgress) => void;
  signal?: AbortSignal;
}): Promise<StoreUploadResult> {
  const { files, linkSecret, passphrase, salt, burn, onProgress, signal } = opts;
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const key = await deriveStoredAesKey(linkSecret, salt, passphrase);

  // 1. Create a storage slot + R2 multipart upload.
  const createRes = await fetchSafe(
    `${httpBase()}/api/store${burn ? "?burn=1" : ""}`,
    { method: "POST", signal },
  );
  if (!createRes.ok) {
    if (createRes.status === 503) {
      throw new Error("Store-and-forward isn't available on this server.");
    }
    if (createRes.status === 429) {
      throw new Error(
        "You've started too many stored transfers recently. Wait a bit and try again, or use Live (direct) mode.",
      );
    }
    throw new Error(`Failed to create storage slot (HTTP ${createRes.status})`);
  }
  const { id, token, partSize } = (await createRes.json()) as {
    id: string;
    token: string;
    partSize: number;
  };
  const PART = partSize || 10 * 1024 * 1024;

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const uploadedParts: { partNumber: number; etag: string }[] = [];
  const entries: ManifestEntry[] = [];

  // Rolling part buffer + global byte cursor.
  let buffer = new Uint8Array(PART);
  let bufFill = 0;
  let partNumber = 0;
  let byteCursor = 0; // total ciphertext bytes emitted so far
  let sentPlainBytes = 0;

  const uploadPart = async (bytes: Uint8Array) => {
    partNumber += 1;
    const thisPart = partNumber;
    const body = toArrayBuffer(bytes);
    // Retry transient failures (network blips) with backoff before giving up,
    // so a momentary drop mid-upload doesn't waste the whole transfer.
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        const res = await fetch(
          `${httpBase()}/api/store/${encodeURIComponent(id)}/parts/${thisPart}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", "X-Token": token },
            body,
            signal,
          },
        );
        if (res.ok) {
          const { etag } = (await res.json()) as { etag: string };
          uploadedParts.push({ partNumber: thisPart, etag });
          return;
        }
        // 4xx (except 408/429) are not worth retrying.
        if (res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new Error(`Part upload failed (HTTP ${res.status})`);
        }
        lastErr = new Error(`Part upload failed (HTTP ${res.status})`);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("cancelled");
        }
        lastErr = err;
      }
      // Backoff before the next attempt (skip after the final one).
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
    // Exhausted retries: surface network failures with an actionable message
    // instead of the browser's raw "Load failed" / "Failed to fetch".
    if (lastErr instanceof TypeError) {
      throw new Error(
        "Upload interrupted — can't reach the SecureSend server. Check your connection and try again.",
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error("Part upload failed");
  };

  // Append ciphertext bytes into the part buffer, flushing full parts.
  const appendToBuffer = async (frame: Uint8Array) => {
    let offset = 0;
    while (offset < frame.length) {
      const space = PART - bufFill;
      const take = Math.min(space, frame.length - offset);
      buffer.set(frame.subarray(offset, offset + take), bufFill);
      bufFill += take;
      offset += take;
      if (bufFill === PART) {
        await uploadPart(buffer);
        buffer = new Uint8Array(PART);
        bufFill = 0;
      }
    }
    byteCursor += frame.length;
  };

  // 2. Stream-encrypt each file into the part buffer.
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const meta: FileMetadata = {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      chunkSize,
      totalChunks: Math.ceil(file.size / chunkSize) || 0,
      transferId: randomTransferId(),
    };
    const regionStart = byteCursor;

    for await (const { index, data } of readFileChunks(file, chunkSize)) {
      if (signal?.aborted) throw new Error("cancelled");
      const iv = generateIV();
      const aad = buildChunkAAD(meta, index);
      const ct = await encryptChunk(key, iv, data, aad);
      const frame = packFrame(iv, index, ct);
      await appendToBuffer(frame);
      data.fill(0);

      sentPlainBytes += data.length;
      onProgress({
        bytes: sentPlainBytes,
        totalBytes,
        items: i,
        totalItems: files.length,
        currentName: file.name,
        bytesPerSecond: 0,
        etaSeconds: Infinity,
        fraction: totalBytes > 0 ? (sentPlainBytes / totalBytes) * 0.97 : 0.97,
      });
    }

    entries.push({
      ...meta,
      byteOffset: regionStart,
      byteLength: byteCursor - regionStart,
    });
  }

  // Flush the final partial part (R2 allows the last part to be < part size).
  if (bufFill > 0) {
    await uploadPart(buffer.subarray(0, bufFill));
  }
  if (uploadedParts.length === 0) {
    // Zero-byte transfer (e.g. empty file): upload a single empty part.
    await uploadPart(new Uint8Array(0));
  }

  // 3. Encrypt the manifest with the same key (its own IV + AAD).
  const manifest: Manifest = { version: 1, files: entries };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestIv = generateIV();
  const manifestAad = new TextEncoder().encode("securesend/store/manifest");
  const manifestCt = await encryptChunk(key, manifestIv, manifestBytes, manifestAad);
  const manifestEnvelope = new Uint8Array(
    salt.length + manifestIv.length + manifestCt.length,
  );
  manifestEnvelope.set(salt, 0);
  manifestEnvelope.set(manifestIv, salt.length);
  manifestEnvelope.set(manifestCt, salt.length + manifestIv.length);

  // 4. Complete the multipart upload, attaching the encrypted manifest.
  const completeRes = await fetchSafe(
    `${httpBase()}/api/store/${encodeURIComponent(id)}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify({
        parts: uploadedParts,
        manifest: bytesToBase64(manifestEnvelope),
        size: byteCursor,
      }),
      signal,
    },
  );
  if (!completeRes.ok) {
    // 429 with our marker means the per-IP store byte budget was exceeded.
    if (completeRes.status === 429) {
      throw new Error(
        "You've reached the storage limit for now. Use Live (direct) mode, or try again later.",
      );
    }
    throw new Error(`Finalizing upload failed (HTTP ${completeRes.status})`);
  }

  onProgress({
    bytes: totalBytes,
    totalBytes,
    items: files.length,
    totalItems: files.length,
    currentName: "",
    bytesPerSecond: 0,
    etaSeconds: 0,
    fraction: 1,
  });

  // The upload has already succeeded; the expiry lookup is informational only,
  // so a network blip here must NOT fail the transfer. Fall back to the
  // default TTL for display purposes.
  let expiresAt = Date.now() + 86400_000;
  try {
    const metaRes = await fetch(
      `${httpBase()}/api/store/${encodeURIComponent(id)}/meta`,
    );
    if (metaRes.ok) {
      expiresAt = ((await metaRes.json()) as { expiresAt: number }).expiresAt;
    }
  } catch {
    /* keep fallback */
  }

  return { id, expiresAt };
}

/** Does a stored transfer exist (and is it still available)? */
export async function storedExists(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${httpBase()}/api/store/${encodeURIComponent(id)}/meta`);
    return res.ok;
  } catch {
    // A network failure isn't "gone"; but for the caller's purposes (can we
    // proceed with a stored download right now?) the answer is still no.
    return false;
  }
}

/**
 * Download + decrypt a stored transfer. Derives the key from `linkSecret`
 * (+ passphrase) and reassembles the original files.
 *
 * IMPORTANT (burn-after-download): this function NO LONGER burns the stored
 * copy on its own. Decrypting into an in-memory blob is NOT the same as the
 * user having the file safely on their device — in an in-app browser the save
 * step can still fail. Burning here would destroy the only copy before the
 * user actually has it. Instead we return the `burn` flag and let the caller
 * fire `burnStored(id)` only after a CONFIRMED save (see TransferSession).
 * Reads are idempotent, so the recipient can retry the download as many times
 * as needed until that confirmed save.
 */
export async function downloadStored(opts: {
  id: string;
  linkSecret: string;
  passphrase?: string;
  onProgress: (p: TransferProgress) => void;
}): Promise<{ items: ReceivedItem[]; burn: boolean }> {
  const { id, linkSecret, passphrase, onProgress } = opts;

  // 1. Fetch + decrypt the manifest (shared with the streaming path).
  const { key, manifest, burn } = await fetchManifest(id, linkSecret, passphrase);

  // 2. Download the ciphertext blob, resuming via HTTP Range if the network
  //    drops mid-download (so a blip doesn't restart a large fetch from zero).
  const totalCipherBytes = manifest.files.reduce(
    (n, f) => n + f.byteLength,
    0,
  );
  const blobBytes = await fetchBlobWithResume(id, totalCipherBytes, (recv) => {
    // Coarse download progress (pre-decrypt) so the UI moves during the fetch.
    if (totalCipherBytes > 0) {
      onProgress({
        bytes: 0,
        totalBytes: manifest.files.reduce((n, f) => n + f.size, 0),
        items: 0,
        totalItems: manifest.files.length,
        currentName: manifest.files[0]?.name ?? "",
        bytesPerSecond: 0,
        etaSeconds: Infinity,
        fraction: Math.min(0.5, (recv / totalCipherBytes) * 0.5),
      });
    }
  });

  const totalBytes = manifest.files.reduce((n, f) => n + f.size, 0);
  let doneBytes = 0;
  const items: ReceivedItem[] = [];

  // 3. Decrypt each file's frame region and reassemble.
  for (let i = 0; i < manifest.files.length; i++) {
    const entry = manifest.files[i];
    const region = blobBytes.subarray(
      entry.byteOffset,
      entry.byteOffset + entry.byteLength,
    );
    const parts: Uint8Array[] = [];
    let cursor = 0;
    for (let chunkIndex = 0; chunkIndex < entry.totalChunks; chunkIndex++) {
      const plainLen = Math.min(
        entry.chunkSize,
        entry.size - chunkIndex * entry.chunkSize,
      );
      const fLen = frameSize(plainLen);
      const frame = region.subarray(cursor, cursor + fLen);
      cursor += fLen;
      const { iv, chunkIndex: idx, ciphertext } = unpackFrame(frame);
      const aad = buildChunkAAD(entry, idx);
      const plain = await decryptChunk(key, iv, ciphertext, aad);
      parts.push(plain);
      doneBytes += plain.length;
      onProgress({
        bytes: doneBytes,
        totalBytes,
        items: i,
        totalItems: manifest.files.length,
        currentName: entry.name,
        bytesPerSecond: 0,
        etaSeconds: Infinity,
        fraction: totalBytes > 0 ? doneBytes / totalBytes : 1,
      });
    }
    items.push({
      blob: new Blob(parts as BlobPart[], {
        type: entry.mime || "application/octet-stream",
      }),
      meta: entry,
    });
  }

  // Burn-after-download is deferred: we return the flag and let the caller burn
  // only after the user CONFIRMS a save. Decrypting in memory isn't possession.
  return { items, burn };
}

/** Tell the server to burn (delete) a burn-after-download transfer. */
export async function burnStored(id: string): Promise<void> {
  try {
    await fetch(`${httpBase()}/api/store/${encodeURIComponent(id)}/burn`, {
      method: "POST",
    });
  } catch {
    /* best effort; expiry will clean up regardless */
  }
}

/** Result of a streaming download: how it was saved + the file metadata. */
export interface StreamDownloadResult {
  savedToDisk: boolean;
  files: { name: string; size: number; mime: string }[];
}

/**
 * Fetch + decrypt a stored transfer, STREAMING decrypted bytes straight to disk
 * where the browser supports it (desktop Chromium via the File System Access
 * API). Peak memory stays ~one chunk regardless of file size.
 *
 * Streaming-to-disk is only attempted for SINGLE-file transfers (the picker
 * saves one file). For multi-file transfers, or browsers without the API, the
 * caller should fall back to `downloadStored` (in-memory reassembly). Use
 * `canStreamStored` to decide.
 *
 * MUST be invoked from a user gesture so the save-file picker can open.
 */
export async function downloadStoredToDisk(opts: {
  id: string;
  linkSecret: string;
  passphrase?: string;
  onProgress: (p: TransferProgress) => void;
}): Promise<StreamDownloadResult> {
  const { id, linkSecret, passphrase, onProgress } = opts;

  const { key, manifest, burn } = await fetchManifest(id, linkSecret, passphrase);
  if (manifest.files.length !== 1) {
    throw new Error("Streaming is only supported for single-file transfers.");
  }
  const entry = manifest.files[0];
  const totalBytes = entry.size;

  // Open the destination file (prompts the user to choose a location).
  const sink = await createFileSink(entry.name, entry.mime);

  // Stream the ciphertext body and de-frame as bytes arrive.
  let blobRes: Response;
  try {
    blobRes = await fetchSafe(`${httpBase()}/api/store/${encodeURIComponent(id)}`);
  } catch (err) {
    await sink.abort();
    throw err;
  }
  if (!blobRes.ok || !blobRes.body) {
    await sink.abort();
    throw new Error(`Download failed (HTTP ${blobRes.status})`);
  }

  const schedule = buildFrameSchedule([entry]);
  let doneBytes = 0;
  let failed: Error | null = null;

  const deframer = new StreamDeframer(schedule, async (frame) => {
    const { iv, chunkIndex, ciphertext } = unpackFrame(frame);
    const aad = buildChunkAAD(entry, chunkIndex);
    let plain: Uint8Array;
    try {
      plain = await decryptChunk(key, iv, ciphertext, aad);
    } catch {
      failed = new Error(
        "Couldn't decrypt this transfer. The link or passphrase may be wrong.",
      );
      throw failed;
    }
    await sink.write(plain);
    doneBytes += plain.length;
    onProgress({
      bytes: doneBytes,
      totalBytes,
      items: 0,
      totalItems: 1,
      currentName: entry.name,
      bytesPerSecond: 0,
      etaSeconds: Infinity,
      fraction: totalBytes > 0 ? doneBytes / totalBytes : 1,
    });
  });

  // Stream the ciphertext body, RESUMING with a Range request if the network
  // drops mid-download. `deframer.consumed` tracks how many ciphertext bytes
  // we've durably processed, so we restart exactly there instead of from zero.
  try {
    await streamWithResume(blobRes, id, deframer);
  } catch (err) {
    await sink.abort();
    throw failed ?? friendlyNetworkError(err);
  }

  if (!deframer.done) {
    await sink.abort();
    throw new Error("Transfer ended early — the file may be incomplete.");
  }

  await sink.close();
  // Burn-after-download: delete the stored copy now that it's saved.
  if (burn) await burnStored(id);
  return {
    savedToDisk: sink.kind === "stream",
    files: [{ name: entry.name, size: entry.size, mime: entry.mime }],
  };
}

/** Max resume attempts after a mid-stream network drop. */
const RESUME_MAX_ATTEMPTS = 5;

/**
 * Drive a streaming download into the de-framer, transparently RESUMING from
 * the last processed byte (via HTTP Range) if the connection drops. The first
 * response is already in hand; subsequent attempts re-fetch with a Range header
 * starting at `deframer.consumed`.
 */
async function streamWithResume(
  firstResponse: Response,
  id: string,
  deframer: StreamDeframer,
): Promise<void> {
  let response: Response | null = firstResponse;
  let attempt = 0;

  for (;;) {
    if (!response) {
      // Re-request the remaining bytes from where we left off.
      response = await fetchSafe(`${httpBase()}/api/store/${encodeURIComponent(id)}`, {
        headers: { Range: `bytes=${deframer.consumed}-` },
        cache: "no-store",
      });
      // 200 (server ignored Range) is only safe if we haven't consumed anything;
      // otherwise we'd double-feed already-processed bytes.
      if (response.status === 200 && deframer.consumed > 0) {
        throw new Error("Server does not support resuming this download.");
      }
      if (!response.ok || !response.body) {
        throw new Error(`Download failed (HTTP ${response.status})`);
      }
    }

    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await deframer.push(value);
      }
      return; // stream finished without error
    } catch (err) {
      // A decrypt failure is fatal (thrown from the deframer callback) — don't
      // retry it as if it were a network blip.
      if (deframer.failed) throw err;
      attempt += 1;
      if (attempt >= RESUME_MAX_ATTEMPTS) throw friendlyNetworkError(err);
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      response = null; // trigger a ranged re-fetch on the next loop
    }
  }
}

/**
 * Download the full ciphertext blob into memory, RESUMING via HTTP Range if the
 * connection drops mid-download. Used by the in-memory `downloadStored` path so
 * a network blip on a large transfer doesn't restart the whole fetch from zero.
 *
 * @param expectedBytes Total ciphertext size (from the manifest) so we know
 *   when we're done and can size the output buffer.
 * @param onBytes Optional progress callback with bytes received so far.
 */
async function fetchBlobWithResume(
  id: string,
  expectedBytes: number,
  onBytes?: (received: number) => void,
): Promise<Uint8Array> {
  const url = `${httpBase()}/api/store/${encodeURIComponent(id)}`;
  const out = new Uint8Array(expectedBytes);
  let received = 0;
  let attempt = 0;

  for (;;) {
    const headers: Record<string, string> =
      received > 0 ? { Range: `bytes=${received}-` } : {};
    let response: Response;
    try {
      response = await fetch(url, { headers, cache: "no-store" });
    } catch (err) {
      attempt += 1;
      if (attempt >= RESUME_MAX_ATTEMPTS) throw friendlyNetworkError(err);
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }
    // If we've already received some bytes, a 200 (Range ignored) would
    // re-send from zero and double-fill; only accept 206 in that case.
    if (received > 0 && response.status === 200) {
      throw new Error("Server does not support resuming this download.");
    }
    if (!response.ok || !response.body) {
      // 404/410 etc. are fatal (gone/expired) — don't retry.
      if (response.status === 404) throw new Error("This transfer no longer exists.");
      if (response.status === 410) throw new Error("This transfer has expired.");
      attempt += 1;
      if (attempt >= RESUME_MAX_ATTEMPTS) {
        throw new Error(`Download failed (HTTP ${response.status})`);
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (received + value.length > out.length) {
            throw new Error("Download larger than expected — aborting.");
          }
          out.set(value, received);
          received += value.length;
          onBytes?.(received);
        }
      }
      if (received >= expectedBytes) return out;
      // Stream ended early without an error: loop to resume from `received`.
    } catch (err) {
      attempt += 1;
      if (attempt >= RESUME_MAX_ATTEMPTS) throw friendlyNetworkError(err);
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Whether a streaming-to-disk download should be offered for this transfer:
 * the browser supports the File System Access API AND it's a single file.
 * (Reads the manifest to learn the file count.)
 */
export async function canStreamStored(
  id: string,
  linkSecret: string,
  passphrase?: string,
): Promise<boolean> {
  if (!canStreamToDisk()) return false;
  try {
    const { manifest } = await fetchManifest(id, linkSecret, passphrase);
    return manifest.files.length === 1;
  } catch {
    return false;
  }
}

/** Shared helper: fetch + decrypt the manifest, returning it, the key, and burn flag. */
async function fetchManifest(
  id: string,
  linkSecret: string,
  passphrase?: string,
): Promise<{ key: CryptoKey; manifest: Manifest; burn: boolean }> {
  const metaRes = await fetchSafe(
    `${httpBase()}/api/store/${encodeURIComponent(id)}/meta`,
  );
  if (metaRes.status === 404) throw new Error("This transfer no longer exists.");
  if (metaRes.status === 410) throw new Error("This transfer has expired.");
  if (!metaRes.ok) throw new Error(`Could not load transfer (HTTP ${metaRes.status})`);
  const { manifest: manifestB64, burn } = (await metaRes.json()) as {
    manifest: string;
    burn?: boolean;
  };
  if (!manifestB64) throw new Error("Transfer manifest missing.");

  const env = base64ToBytes(manifestB64);
  const salt = env.subarray(0, 16);
  const manifestIv = env.subarray(16, 16 + IV_LENGTH);
  const manifestCt = env.subarray(16 + IV_LENGTH);

  const key = await deriveStoredAesKey(linkSecret, salt, passphrase);
  const manifestAad = new TextEncoder().encode("securesend/store/manifest");
  try {
    const manifestBytes = await decryptChunk(key, manifestIv, manifestCt, manifestAad);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    return { key, manifest, burn: !!burn };
  } catch {
    throw new Error(
      "Couldn't decrypt this transfer. The link may be incomplete or the passphrase is wrong.",
    );
  }
}
