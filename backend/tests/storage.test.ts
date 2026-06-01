import { describe, it, expect, beforeEach } from "vitest";
import { handleStore, isValidId, parseRange, randomToken, storeTtl } from "../src/storage";
import type { Env } from "../src/index";

// ---------------------------------------------------------------------------
// Minimal in-memory R2 fake. Implements only the surface handleStore uses:
// put/get/delete + multipart create/resume(complete/abort/uploadPart).
// ---------------------------------------------------------------------------

interface StoredObj {
  body: Uint8Array;
  text: string;
}

class FakeR2 {
  objects = new Map<string, StoredObj>();
  private mpCounter = 0;
  multiparts = new Map<string, { key: string; parts: Map<number, Uint8Array>; completed: boolean; aborted: boolean }>();

  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void> {
    let text = "";
    let body = new Uint8Array();
    if (typeof value === "string") {
      text = value;
      body = new TextEncoder().encode(value);
    } else {
      body = value instanceof Uint8Array ? value : new Uint8Array(value);
      text = new TextDecoder().decode(body);
    }
    this.objects.set(key, { body, text });
  }

  async get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<{ body: unknown; json: () => Promise<unknown>; text: () => Promise<string> } | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    let body = obj.body;
    if (opts?.range) {
      const { offset, length } = opts.range;
      body = obj.body.subarray(offset, offset + length);
    }
    return {
      body,
      json: async () => JSON.parse(obj.text),
      text: async () => obj.text,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const uploadId = `mp-${++this.mpCounter}`;
    this.multiparts.set(uploadId, { key, parts: new Map(), completed: false, aborted: false });
    return { uploadId };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const self = this;
    return {
      async uploadPart(partNumber: number, body: ArrayBuffer | Uint8Array) {
        const mp = self.multiparts.get(uploadId);
        if (!mp) throw new Error("no such upload");
        mp.parts.set(partNumber, body instanceof Uint8Array ? body : new Uint8Array(body));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        const mp = self.multiparts.get(uploadId);
        if (!mp) throw new Error("no such upload");
        // Concatenate parts in order into the final object.
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        const chunks = ordered.map((p) => mp.parts.get(p.partNumber) ?? new Uint8Array());
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        self.objects.set(key, { body: merged, text: "" });
        mp.completed = true;
      },
      abort() {
        const mp = self.multiparts.get(uploadId);
        if (mp) mp.aborted = true;
      },
    };
  }
}

function makeEnv(bucket: FakeR2 | null): Env {
  return {
    BLOBS: bucket as unknown as Env["BLOBS"],
    STORE_TTL_SECONDS: "86400",
  } as unknown as Env;
}

const CORS = { "Access-Control-Allow-Origin": "*" };

function req(method: string, path: string, opts: { token?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["X-Token"] = opts.token;
  return new Request(`https://signal.test${path}`, {
    method,
    headers,
    body: opts.body,
  });
}

describe("storage helpers", () => {
  it("isValidId mirrors the room-id shape", () => {
    expect(isValidId("A".repeat(16))).toBe(true);
    expect(isValidId("nope")).toBe(false);
    expect(isValidId("../escape")).toBe(false);
  });

  it("randomToken is url-safe and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toMatch(/[+/=]/);
    expect(a).not.toBe(b);
  });

  it("storeTtl falls back to 86400 on bad input", () => {
    expect(storeTtl({ STORE_TTL_SECONDS: "abc" } as unknown as Env)).toBe(86400);
    expect(storeTtl({ STORE_TTL_SECONDS: "100" } as unknown as Env)).toBe(100);
    expect(storeTtl({} as unknown as Env)).toBe(86400);
  });

  it("parseRange handles start-end, open-ended, suffix, and bad input", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 1000)).toEqual({ start: 100, end: 999 });
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    // End past EOF is clamped.
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    // Unsatisfiable / malformed -> null (caller returns 416).
    expect(parseRange("bytes=2000-3000", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=50-10", 1000)).toBeNull();
    // Multi-range not supported -> null.
    expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
  });
});

describe("handleStore routing", () => {
  let bucket: FakeR2;
  let env: Env;
  beforeEach(() => {
    bucket = new FakeR2();
    env = makeEnv(bucket);
  });

  it("returns null when R2 is not configured", async () => {
    const res = await handleStore(req("POST", "/api/store"), makeEnv(null), CORS);
    expect(res).toBeNull();
  });

  it("creates a slot and returns id + token", async () => {
    const res = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; token: string; partSize: number };
    expect(isValidId(body.id)).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.partSize).toBeGreaterThan(0);
  });

  it("rejects part upload with a wrong token (403)", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id } = (await create.json()) as { id: string };
    const res = (await handleStore(
      req("PUT", `/api/store/${id}/parts/1`, { token: "wrong", body: new Uint8Array([1, 2, 3]) }),
      env,
      CORS,
    ))!;
    expect(res.status).toBe(403);
  });

  it("performs a full upload -> complete -> meta -> download cycle", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };

    const part = (await handleStore(
      req("PUT", `/api/store/${id}/parts/1`, { token, body: new Uint8Array([1, 2, 3, 4]) }),
      env,
      CORS,
    ))!;
    expect(part.status).toBe(200);
    const partBody = (await part.json()) as { partNumber: number; etag: string };

    const complete = (await handleStore(
      req("POST", `/api/store/${id}/complete`, {
        token,
        body: JSON.stringify({ parts: [partBody], manifest: "enc-manifest", size: 4 }),
      }),
      env,
      CORS,
    ))!;
    expect(complete.status).toBe(200);

    const meta = (await handleStore(req("GET", `/api/store/${id}/meta`), env, CORS))!;
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { manifest: string; size: number };
    expect(metaBody.manifest).toBe("enc-manifest");
    expect(metaBody.size).toBe(4);

    const dl = (await handleStore(req("GET", `/api/store/${id}`), env, CORS))!;
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Length")).toBe("4");
    expect(dl.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("serves a partial 206 response for a Range request (resumable download)", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };
    const part = (await handleStore(
      req("PUT", `/api/store/${id}/parts/1`, { token, body: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]) }),
      env,
      CORS,
    ))!;
    const partBody = (await part.json()) as { partNumber: number; etag: string };
    await handleStore(
      req("POST", `/api/store/${id}/complete`, {
        token,
        body: JSON.stringify({ parts: [partBody], manifest: "m", size: 8 }),
      }),
      env,
      CORS,
    );

    // Resume from byte 4 onward.
    const ranged = (await handleStore(
      req("GET", `/api/store/${id}`, { headers: { Range: "bytes=4-" } }),
      env,
      CORS,
    ))!;
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 4-7/8");
    expect(ranged.headers.get("Content-Length")).toBe("4");
    const body = new Uint8Array(await ranged.arrayBuffer());
    expect(Array.from(body)).toEqual([50, 60, 70, 80]);

    // An unsatisfiable range yields 416 with the valid extent.
    const bad = (await handleStore(
      req("GET", `/api/store/${id}`, { headers: { Range: "bytes=99-200" } }),
      env,
      CORS,
    ))!;
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */8");
  });

  it("DELETE requires the owner token", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };

    const forbidden = (await handleStore(req("DELETE", `/api/store/${id}`, { token: "nope" }), env, CORS))!;
    expect(forbidden.status).toBe(403);

    const ok = (await handleStore(req("DELETE", `/api/store/${id}`, { token }), env, CORS))!;
    expect(ok.status).toBe(200);
  });

  it("burn endpoint is forbidden for non-burn slots, allowed for burn slots", async () => {
    // Non-burn slot: /burn must be refused so a stranger can't nuke it.
    const normal = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id: normalId } = (await normal.json()) as { id: string };
    const refusedBurn = (await handleStore(req("POST", `/api/store/${normalId}/burn`), env, CORS))!;
    expect(refusedBurn.status).toBe(403);

    // Burn slot: /burn (token-less) is allowed.
    const burn = (await handleStore(req("POST", "/api/store?burn=1"), env, CORS))!;
    const { id: burnId } = (await burn.json()) as { id: string };
    const okBurn = (await handleStore(req("POST", `/api/store/${burnId}/burn`), env, CORS))!;
    expect(okBurn.status).toBe(200);
    // Meta + body should be gone after a burn.
    expect(bucket.objects.has(`${burnId}:meta`)).toBe(false);
    expect(bucket.objects.has(`blob/${burnId}`)).toBe(false);
  });

  it("rejects invalid ids and out-of-range part numbers", async () => {
    const badId = (await handleStore(req("PUT", "/api/store/short/parts/1", { token: "x", body: new Uint8Array() }), env, CORS))!;
    expect(badId.status).toBe(400);

    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };
    const badPart = (await handleStore(
      req("PUT", `/api/store/${id}/parts/0`, { token, body: new Uint8Array() }),
      env,
      CORS,
    ))!;
    expect(badPart.status).toBe(400);
  });

  it("returns 404 meta for a non-existent / not-yet-completed slot", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id } = (await create.json()) as { id: string };
    // Created but not completed -> meta 404.
    const meta = (await handleStore(req("GET", `/api/store/${id}/meta`), env, CORS))!;
    expect(meta.status).toBe(404);
  });

  it("rejects an over-byte-budget completion (429) and persists nothing", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };
    const part = (await handleStore(
      req("PUT", `/api/store/${id}/parts/1`, { token, body: new Uint8Array([1, 2, 3, 4]) }),
      env,
      CORS,
    ))!;
    const partBody = (await part.json()) as { partNumber: number; etag: string };

    // chargeBytes returns false => over budget.
    const complete = (await handleStore(
      req("POST", `/api/store/${id}/complete`, {
        token,
        body: JSON.stringify({ parts: [partBody], manifest: "m", size: 9_999_999_999 }),
      }),
      env,
      CORS,
      async () => false,
    ))!;
    expect(complete.status).toBe(429);
    // Slot meta deleted, nothing committed to the blob store.
    expect(bucket.objects.has(`${id}:meta`)).toBe(false);
    expect(bucket.objects.has(`blob/${id}`)).toBe(false);
  });

  it("allows an in-budget completion when chargeBytes returns true", async () => {
    const create = (await handleStore(req("POST", "/api/store"), env, CORS))!;
    const { id, token } = (await create.json()) as { id: string; token: string };
    const part = (await handleStore(
      req("PUT", `/api/store/${id}/parts/1`, { token, body: new Uint8Array([1, 2, 3, 4]) }),
      env,
      CORS,
    ))!;
    const partBody = (await part.json()) as { partNumber: number; etag: string };
    const complete = (await handleStore(
      req("POST", `/api/store/${id}/complete`, {
        token,
        body: JSON.stringify({ parts: [partBody], manifest: "m", size: 4 }),
      }),
      env,
      CORS,
      async () => true,
    ))!;
    expect(complete.status).toBe(200);
  });
});
