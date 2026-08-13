/**
 * storage.ts — OPTIONAL store-and-forward via Cloudflare R2 (multipart).
 *
 * The server stores ONLY client-side-encrypted ciphertext. It never receives
 * the encryption key (which lives in the invite link's URL fragment), so it
 * cannot read any stored file. Blobs auto-expire after STORE_TTL_SECONDS (and
 * via an R2 lifecycle rule as defense-in-depth).
 *
 * Uploads use R2 MULTIPART so there is no practical size limit (a single
 * Worker request body is capped, but each multipart PART is a separate request
 * well under that cap; R2 allows up to 10,000 parts).
 *
 * Endpoints (all under /api/store):
 *   POST   /api/store                  -> { id, token, partSize, ttlSeconds }
 *   PUT    /api/store/:id/parts/:n     (X-Token; body = part bytes) -> { partNumber, etag }
 *   POST   /api/store/:id/complete     (X-Token; body = { parts, manifest, size })
 *   GET    /api/store/:id/meta         -> { manifest, size, expiresAt } | 404
 *   GET    /api/store/:id              -> ciphertext bytes (streamed) | 404
 *   DELETE /api/store/:id              (X-Token) -> delete / abort
 *
 * The manifest (filenames, sizes, mime, framing offsets) is itself a
 * client-encrypted opaque string; the server never interprets it.
 */

import type { Env } from "./index";

interface StoredMeta {
  /** Owner token required to upload parts / complete / delete. */
  token: string;
  /** R2 multipart upload id (so a fresh Worker invocation can resume). */
  uploadId: string;
  /** Total ciphertext size in bytes (set on complete). */
  size: number;
  /** Absolute epoch-ms expiry. */
  expiresAt: number;
  /** Whether the multipart upload has been completed. */
  uploaded: boolean;
  /** Opaque client-encrypted manifest (base64). */
  manifest: string | null;
  /**
   * Burn-after-download: when true, the recipient may delete the blob (via the
   * token-less /burn endpoint) once they've successfully downloaded + decrypted
   * it, so it exists for exactly one retrieval.
   */
  burn: boolean;
}

/** Multipart part size: 10 MiB. Above R2's 5 MiB minimum, below Worker limits. */
const PART_SIZE = 10 * 1024 * 1024;

/**
 * Upper bound for the (opaque, client-encrypted) manifest string. The server
 * never reads it, but bounding it stops a client from stashing arbitrarily
 * large data in what is supposed to be small metadata.
 */
const MAX_MANIFEST_CHARS = 1_000_000;

/** R2's multipart limit; also bounds the completion payload. */
const MAX_PARTS = 10000;

/** JSON completion metadata is bounded independently of ciphertext parts. */
const MAX_COMPLETION_BYTES = 4 * 1024 * 1024;

/** Keep an individual R2 ETag small and free of header/control characters. */
const MAX_ETAG_CHARS = 512;

const META_SUFFIX = ":meta";
const BODY_PREFIX = "blob/";

export function randomToken(bytes = 18): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function storeTtl(env: Env): number {
  const n = parseInt(env.STORE_TTL_SECONDS ?? "86400", 10);
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{16,48}$/.test(id);
}

class PayloadTooLargeError extends Error {}
class EmptyPayloadError extends Error {}

function validateDeclaredBodyLength(request: Request, maxBytes: number): void {
  const declared = request.headers.get("Content-Length");
  if (declared === null) return;
  if (!/^\d+$/.test(declared)) throw new TypeError("Invalid Content-Length");
  const length = Number(declared);
  if (!Number.isSafeInteger(length)) throw new TypeError("Invalid Content-Length");
  if (length > maxBytes) throw new PayloadTooLargeError();
  if (length === 0) throw new EmptyPayloadError();
}

/**
 * Preserve backpressure while enforcing a byte limit even when Content-Length
 * is absent or dishonest. The first non-empty chunk is read before returning
 * so R2 never receives an empty multipart part.
 */
async function boundedBodyStream(
  request: Request,
  maxBytes: number,
): Promise<ReadableStream<Uint8Array>> {
  validateDeclaredBodyLength(request, maxBytes);
  if (!request.body) throw new EmptyPayloadError();

  const reader = request.body.getReader();
  let first: Uint8Array | undefined;
  while (!first) {
    const result = await reader.read();
    if (result.done) throw new EmptyPayloadError();
    if (result.value.byteLength > 0) first = result.value;
  }
  if (first.byteLength > maxBytes) {
    await reader.cancel().catch(() => undefined);
    throw new PayloadTooLargeError();
  }

  let total = first.byteLength;
  let initial: Uint8Array | undefined = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (initial) {
        controller.enqueue(initial);
        initial = undefined;
        return;
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value.byteLength === 0) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            controller.error(new PayloadTooLargeError());
            return;
          }
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  validateDeclaredBodyLength(request, maxBytes);

  if (!request.body) throw new EmptyPayloadError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function tokenMatches(
  provided: string | null,
  expected: string,
): Promise<boolean> {
  if (!provided) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

interface UploadedPart {
  partNumber: number;
  etag: string;
}

function validateUploadedParts(value: unknown): UploadedPart[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTS) {
    return null;
  }
  const seen = new Set<number>();
  const parts: UploadedPart[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const { partNumber, etag } = candidate as Partial<UploadedPart>;
    if (
      !Number.isInteger(partNumber) ||
      (partNumber as number) < 1 ||
      (partNumber as number) > MAX_PARTS ||
      seen.has(partNumber as number) ||
      typeof etag !== "string" ||
      etag.length === 0 ||
      etag.length > MAX_ETAG_CHARS ||
      /[\u0000-\u001f\u007f]/.test(etag)
    ) {
      return null;
    }
    seen.add(partNumber as number);
    parts.push({ partNumber: partNumber as number, etag });
  }
  return parts;
}

/**
 * Handle a /api/store/* request. Returns null only if R2 isn't configured.
 *
 * @param chargeBytes Optional per-IP byte-budget hook invoked at `complete`
 *   with the SERVER-measured ciphertext size (never the client-declared one).
 *   If it returns false, the transfer is over budget: the committed object and
 *   slot are deleted and the request is rejected.
 */
export async function handleStore(
  request: Request,
  env: Env,
  cors: HeadersInit,
  chargeBytes?: (size: number) => Promise<boolean>,
): Promise<Response | null> {
  if (!env.BLOBS) return null; // feature unavailable
  const bucket = env.BLOBS;
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/store -> create a slot + multipart upload.
  if (path === "/api/store" && request.method === "POST") {
    const id = randomToken(18);
    const token = randomToken(18);
    const mp = await bucket.createMultipartUpload(BODY_PREFIX + id);
    // The sender can request burn-after-download via ?burn=1.
    const burn = url.searchParams.get("burn") === "1";
    const meta: StoredMeta = {
      token,
      uploadId: mp.uploadId,
      size: 0,
      expiresAt: Date.now() + storeTtl(env) * 1000,
      uploaded: false,
      manifest: null,
      burn,
    };
    await bucket.put(id + META_SUFFIX, JSON.stringify(meta));
    return json(
      { id, token, partSize: PART_SIZE, ttlSeconds: storeTtl(env), burn },
      201,
      cors,
    );
  }

  // PUT /api/store/:id/parts/:n -> upload one multipart part.
  const partMatch = path.match(/^\/api\/store\/([^/]+)\/parts\/(\d+)$/);
  if (partMatch && request.method === "PUT") {
    const id = decodeURIComponent(partMatch[1]);
    const partNumber = parseInt(partMatch[2], 10);
    if (!isValidId(id)) return text("Invalid id", 400, cors);
    if (!(partNumber >= 1 && partNumber <= MAX_PARTS)) {
      return text("Invalid part number", 400, cors);
    }
    const meta = await readMeta(bucket, id);
    if (!meta) return text("Not found", 404, cors);
    if (!(await tokenMatches(request.headers.get("X-Token"), meta.token))) {
      return text("Forbidden", 403, cors);
    }
    if (meta.expiresAt < Date.now()) {
      // Expired before completion: opportunistically abort the multipart
      // upload and drop the slot, so uncommitted parts don't linger in R2
      // (uncommitted parts consume storage until aborted).
      try {
        await bucket
          .resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId)
          .abort();
      } catch {
        /* ignore */
      }
      await bucket.delete(id + META_SUFFIX);
      return text("Expired", 410, cors);
    }

    let body: ReadableStream<Uint8Array>;
    try {
      body = await boundedBodyStream(request, PART_SIZE);
      const mp = bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId);
      const part = await mp.uploadPart(partNumber, body);
      return json({ partNumber: part.partNumber, etag: part.etag }, 200, cors);
    } catch (error) {
      return text(
        error instanceof PayloadTooLargeError
          ? "Part too large"
          : error instanceof EmptyPayloadError
            ? "Empty part"
            : "Invalid body",
        error instanceof PayloadTooLargeError ? 413 : 400,
        cors,
      );
    }
  }

  // POST /api/store/:id/complete -> finalize the multipart upload.
  const completeMatch = path.match(/^\/api\/store\/([^/]+)\/complete$/);
  if (completeMatch && request.method === "POST") {
    const id = decodeURIComponent(completeMatch[1]);
    if (!isValidId(id)) return text("Invalid id", 400, cors);
    const meta = await readMeta(bucket, id);
    if (!meta) return text("Not found", 404, cors);
    if (!(await tokenMatches(request.headers.get("X-Token"), meta.token))) {
      return text("Forbidden", 403, cors);
    }

    let payload: Record<string, unknown>;
    try {
      const bytes = await readBoundedBody(request, MAX_COMPLETION_BYTES);
      payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch (error) {
      return text(
        error instanceof PayloadTooLargeError ? "Completion payload too large" : "Invalid JSON",
        error instanceof PayloadTooLargeError ? 413 : 400,
        cors,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return text("Invalid payload", 400, cors);
    }
    const parts = validateUploadedParts(payload.parts);
    if (!parts) {
      return text("No parts", 400, cors);
    }
    if (
      typeof payload.manifest !== "string" ||
      payload.manifest.length > MAX_MANIFEST_CHARS
    ) {
      return text("Invalid manifest", 400, cors);
    }

    // Finalize the multipart upload FIRST so R2 can tell us the REAL object
    // size. The byte budget used to be charged with the client-declared
    // `payload.size`, which a dishonest client could simply lie about to
    // bypass the per-IP budget (and corrupt Content-Length on download).
    const mp = bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId);
    let actualSize: number;
    try {
      const committed = await mp.complete(parts);
      actualSize = committed.size;
    } catch {
      return text("Complete failed", 400, cors);
    }

    // Enforce the per-IP byte budget with the server-measured size. If over
    // budget, remove the just-committed object + slot so nothing persists.
    if (chargeBytes) {
      const within = await chargeBytes(actualSize);
      if (!within) {
        await bucket.delete(BODY_PREFIX + id);
        await bucket.delete(id + META_SUFFIX);
        return json(
          { error: "byte-budget-exceeded" },
          429,
          cors,
        );
      }
    }

    meta.uploaded = true;
    meta.size = actualSize;
    meta.manifest = payload.manifest as string;
    await bucket.put(id + META_SUFFIX, JSON.stringify(meta));
    return json({ ok: true }, 200, cors);
  }

  // POST /api/store/:id/burn -> recipient deletes the blob after a successful
  // download (burn-after-download). No owner token required, BUT only allowed
  // for slots created with burn=1, so a random visitor can't nuke a normal
  // transfer. The id+linkSecret already gate read access; this just lets the
  // legitimate recipient clean up immediately rather than waiting for expiry.
  const burnMatch = path.match(/^\/api\/store\/([^/]+)\/burn$/);
  if (burnMatch && request.method === "POST") {
    const id = decodeURIComponent(burnMatch[1]);
    if (!isValidId(id)) return text("Invalid id", 400, cors);
    const meta = await readMeta(bucket, id);
    if (!meta) return json({ ok: true }, 200, cors); // already gone
    if (!meta.burn) {
      // Not a burn transfer; ignore (only the owner token may delete it).
      return text("Forbidden", 403, cors);
    }
    await bucket.delete(BODY_PREFIX + id);
    await bucket.delete(id + META_SUFFIX);
    return json({ ok: true }, 200, cors);
  }

  const m = path.match(/^\/api\/store\/([^/]+)(\/meta)?$/);
  if (!m) return text("Not found", 404, cors);
  const id = decodeURIComponent(m[1]);
  const isMeta = !!m[2];
  if (!isValidId(id)) return text("Invalid id", 400, cors);

  const meta = await readMeta(bucket, id);

  // GET /api/store/:id/meta
  if (request.method === "GET" && isMeta) {
    if (!meta || !meta.uploaded) return text("Not found", 404, cors);
    if (meta.expiresAt < Date.now()) return text("Expired", 410, cors);
    return json(
      {
        manifest: meta.manifest,
        size: meta.size,
        expiresAt: meta.expiresAt,
        burn: meta.burn,
      },
      200,
      cors,
    );
  }

  // GET /api/store/:id  -> stream ciphertext. Supports HTTP Range so a dropped
  // download can RESUME from where it stopped (resilient on flaky mobile
  // networks) instead of restarting from zero. Reads are idempotent and never
  // consume the blob, so any number of attempts (from any IP) are safe; the
  // copy is removed only by an explicit burn after a verified save, or expiry.
  if (request.method === "GET" && !isMeta) {
    if (!meta || !meta.uploaded) return text("Not found", 404, cors);
    if (meta.expiresAt < Date.now()) return text("Expired", 410, cors);

    const rangeHeader = request.headers.get("Range");
    const parsed = rangeHeader ? parseRange(rangeHeader, meta.size) : null;

    // Malformed / unsatisfiable range -> 416 with the valid extent.
    if (rangeHeader && !parsed) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${meta.size}`, ...cors },
      });
    }

    const obj = await bucket.get(
      BODY_PREFIX + id,
      parsed
        ? { range: { offset: parsed.start, length: parsed.end - parsed.start + 1 } }
        : undefined,
    );
    if (!obj) return text("Not found", 404, cors);

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      // Advertise range support so clients know they can resume.
      "Accept-Ranges": "bytes",
    };

    if (parsed) {
      const len = parsed.end - parsed.start + 1;
      return new Response(obj.body, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(len),
          "Content-Range": `bytes ${parsed.start}-${parsed.end}/${meta.size}`,
          ...cors,
        },
      });
    }

    return new Response(obj.body, {
      headers: { ...baseHeaders, "Content-Length": String(meta.size), ...cors },
    });
  }

  // DELETE /api/store/:id -> delete body + meta (and abort if incomplete).
  if (request.method === "DELETE" && !isMeta) {
    if (!meta) return json({ ok: true }, 200, cors);
    if (!(await tokenMatches(request.headers.get("X-Token"), meta.token))) {
      return text("Forbidden", 403, cors);
    }
    if (!meta.uploaded) {
      try {
        await bucket
          .resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId)
          .abort();
      } catch {
        /* ignore */
      }
    }
    await bucket.delete(BODY_PREFIX + id);
    await bucket.delete(id + META_SUFFIX);
    return json({ ok: true }, 200, cors);
  }

  return text("Method not allowed", 405, cors);
}

async function readMeta(bucket: R2Bucket, id: string): Promise<StoredMeta | null> {
  const raw = await bucket.get(id + META_SUFFIX);
  return raw ? ((await raw.json()) as StoredMeta) : null;
}

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Parse a single-range HTTP `Range: bytes=start-end` header against a known
 * total size. Returns null for syntactically invalid, multi-range, or
 * unsatisfiable ranges (caller responds 416). Supports:
 *   bytes=START-END   bytes=START-   bytes=-SUFFIX
 * Pure + exported for unit testing.
 */
export function parseRange(header: string, size: number): ByteRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // not a byte range or multiple ranges (commas) -> ignore
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (size === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    if (!Number.isFinite(start)) return null;
    end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(end)) return null;
  }

  // Clamp end to the last byte; reject if start is past the end of content.
  if (end > size - 1) end = size - 1;
  if (start > end || start < 0) return null;
  return { start, end };
}

function json(obj: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function text(body: string, status: number, cors: HeadersInit): Response {
  return new Response(body, { status, headers: cors });
}
