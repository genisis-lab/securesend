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

/**
 * Handle a /api/store/* request. Returns null only if R2 isn't configured.
 *
 * @param chargeBytes Optional per-IP byte-budget hook invoked at `complete`
 *   with the finalized ciphertext size. If it returns false, the transfer is
 *   over budget: we abort the multipart upload, delete the slot, and reject.
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
    if (!(partNumber >= 1 && partNumber <= 10000)) {
      return text("Invalid part number", 400, cors);
    }
    const meta = await readMeta(bucket, id);
    if (!meta) return text("Not found", 404, cors);
    if (request.headers.get("X-Token") !== meta.token) return text("Forbidden", 403, cors);
    if (meta.expiresAt < Date.now()) return text("Expired", 410, cors);

    const mp = bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId);
    const body = await request.arrayBuffer();
    const part = await mp.uploadPart(partNumber, body);
    return json({ partNumber: part.partNumber, etag: part.etag }, 200, cors);
  }

  // POST /api/store/:id/complete -> finalize the multipart upload.
  const completeMatch = path.match(/^\/api\/store\/([^/]+)\/complete$/);
  if (completeMatch && request.method === "POST") {
    const id = decodeURIComponent(completeMatch[1]);
    if (!isValidId(id)) return text("Invalid id", 400, cors);
    const meta = await readMeta(bucket, id);
    if (!meta) return text("Not found", 404, cors);
    if (request.headers.get("X-Token") !== meta.token) return text("Forbidden", 403, cors);

    const payload = (await request.json()) as {
      parts: { partNumber: number; etag: string }[];
      manifest: string;
      size: number;
    };
    if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
      return text("No parts", 400, cors);
    }

    // Enforce the per-IP byte budget now that we know the finalized size. If
    // over budget, abort the multipart upload and delete the slot so nothing
    // is persisted (the bytes were uploaded as parts but never committed).
    if (chargeBytes) {
      const within = await chargeBytes(payload.size);
      if (!within) {
        try {
          bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId).abort();
        } catch {
          /* ignore */
        }
        await bucket.delete(id + META_SUFFIX);
        return json(
          { error: "byte-budget-exceeded" },
          429,
          cors,
        );
      }
    }

    const mp = bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId);
    try {
      await mp.complete(
        payload.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      );
    } catch (e) {
      return text(`Complete failed: ${e instanceof Error ? e.message : "error"}`, 400, cors);
    }
    meta.uploaded = true;
    meta.size = payload.size;
    meta.manifest = payload.manifest;
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
    if (request.headers.get("X-Token") !== meta.token) return text("Forbidden", 403, cors);
    if (!meta.uploaded) {
      try {
        bucket.resumeMultipartUpload(BODY_PREFIX + id, meta.uploadId).abort();
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
