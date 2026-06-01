import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  uploadStored,
  downloadStored,
  downloadStoredToDisk,
  burnStored,
} from "../src/lib/store-transfer";
import { blobToBytes } from "../src/lib/chunker";
import { randomBytes } from "../src/lib/crypto";

/**
 * Store-and-forward round trip. We mock the Worker's /api/store endpoints with
 * an in-memory store so we can prove: upload encrypts → download with the SAME
 * link secret decrypts exactly, and a WRONG link secret/passphrase fails.
 */

interface Slot {
  token: string;
  parts: Map<number, Uint8Array>;
  body?: Uint8Array;
  manifest?: string;
  size: number;
  expiresAt: number;
  uploaded: boolean;
  burn: boolean;
}

function installFetchMock() {
  const slots = new Map<string, Slot>();
  let counter = 0;

  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method || "GET").toUpperCase();
    // Strip origin AND query string for route matching.
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");

    if (path === "/api/store" && method === "POST") {
      const id = `store${counter++}aaaaaaaaaaaa`;
      const token = "tok" + id;
      slots.set(id, {
        token,
        parts: new Map(),
        size: 0,
        expiresAt: Date.now() + 86400000,
        uploaded: false,
        burn: url.includes("burn=1"),
      });
      return jsonRes({ id, token, partSize: 10 * 1024 * 1024, ttlSeconds: 86400 }, 201);
    }

    const burnMatch = path.match(/^\/api\/store\/([^/]+)\/burn$/);
    if (burnMatch && method === "POST") {
      const slot = slots.get(burnMatch[1]);
      if (slot && slot.burn) slots.delete(burnMatch[1]);
      return jsonRes({ ok: true }, 200);
    }

    const partMatch = path.match(/^\/api\/store\/([^/]+)\/parts\/(\d+)$/);
    if (partMatch && method === "PUT") {
      const slot = slots.get(partMatch[1]);
      if (!slot) return textRes("Not found", 404);
      if (init.headers?.["X-Token"] !== slot.token) return textRes("Forbidden", 403);
      const n = parseInt(partMatch[2], 10);
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      slot.parts.set(n, bytes);
      return jsonRes({ partNumber: n, etag: `etag-${n}` }, 200);
    }

    const completeMatch = path.match(/^\/api\/store\/([^/]+)\/complete$/);
    if (completeMatch && method === "POST") {
      const slot = slots.get(completeMatch[1]);
      if (!slot) return textRes("Not found", 404);
      if (init.headers?.["X-Token"] !== slot.token) return textRes("Forbidden", 403);
      const payload = JSON.parse(init.body as string) as {
        parts: { partNumber: number; etag: string }[];
        manifest: string;
        size: number;
      };
      // Concatenate parts in order to form the body.
      const ordered = payload.parts
        .map((p) => p.partNumber)
        .sort((a, b) => a - b);
      const total = ordered.reduce((n, pn) => n + (slot.parts.get(pn)?.length ?? 0), 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const pn of ordered) {
        const part = slot.parts.get(pn)!;
        body.set(part, off);
        off += part.length;
      }
      slot.body = body;
      slot.manifest = payload.manifest;
      slot.size = payload.size;
      slot.uploaded = true;
      return jsonRes({ ok: true }, 200);
    }

    const metaMatch = path.match(/^\/api\/store\/([^/]+)\/meta$/);
    if (metaMatch && method === "GET") {
      const slot = slots.get(metaMatch[1]);
      if (!slot || !slot.uploaded) return textRes("Not found", 404);
      return jsonRes(
        {
          manifest: slot.manifest,
          size: slot.size,
          expiresAt: slot.expiresAt,
          burn: slot.burn,
        },
        200,
      );
    }

    const getMatch = path.match(/^\/api\/store\/([^/]+)$/);
    if (getMatch && method === "GET") {
      const slot = slots.get(getMatch[1]);
      if (!slot || !slot.uploaded || !slot.body) return textRes("Not found", 404);
      const body = slot.body;
      // Provide BOTH arrayBuffer() (in-memory path) and a chunked ReadableStream
      // body (streaming path), so either download method works in tests.
      const makeStream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Emit in small slices to exercise the de-framer's split handling.
            const step = 7;
            for (let i = 0; i < body.length; i += step) {
              controller.enqueue(body.subarray(i, Math.min(i + step, body.length)));
            }
            controller.close();
          },
        });
      return {
        ok: true,
        status: 200,
        body: makeStream(),
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as any;
    }

    return textRes("Not found", 404);
  });

  vi.stubGlobal("fetch", mock);
  return slots;
}

function jsonRes(obj: unknown, status: number) {
  return { ok: status < 400, status, json: async () => obj } as any;
}
function textRes(body: string, status: number) {
  return { ok: status < 400, status, text: async () => body, json: async () => ({}) } as any;
}

describe("store-and-forward round trip", () => {
  beforeEach(() => {
    installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads encrypted, then downloads + decrypts the same files", async () => {
    const linkSecret = "test-link-secret-123";
    const salt = randomBytes(16);
    const a = randomBytes(2500);
    const b = randomBytes(300);
    const files = [
      new File([a as BlobPart], "photo.bin", { type: "application/octet-stream" }),
      new File([b as BlobPart], "note.txt", { type: "text/plain" }),
    ];

    const { id } = await uploadStored({
      files,
      linkSecret,
      salt,
      onProgress: () => {},
    });
    expect(id).toBeTruthy();

    const { items } = await downloadStored({ id, linkSecret, onProgress: () => {} });
    expect(items.map((i) => i.meta.name)).toEqual(["photo.bin", "note.txt"]);
    expect(await blobToBytes(items[0].blob!)).toEqual(a);
    expect(await blobToBytes(items[1].blob!)).toEqual(b);
    expect(items[1].meta.mime).toBe("text/plain");
  });

  it("fails to decrypt with the wrong link secret", async () => {
    const salt = randomBytes(16);
    const data = randomBytes(1000);
    const files = [new File([data as BlobPart], "secret.bin")];

    const { id } = await uploadStored({
      files,
      linkSecret: "correct-secret",
      salt,
      onProgress: () => {},
    });

    await expect(
      downloadStored({ id, linkSecret: "wrong-secret", onProgress: () => {} }),
    ).rejects.toThrow();
  });

  it("requires the matching passphrase when one was set", async () => {
    const salt = randomBytes(16);
    const data = randomBytes(500);
    const files = [new File([data as BlobPart], "x.bin")];

    const { id } = await uploadStored({
      files,
      linkSecret: "s",
      passphrase: "hunter2",
      salt,
      onProgress: () => {},
    });

    await expect(
      downloadStored({ id, linkSecret: "s", passphrase: "wrong", onProgress: () => {} }),
    ).rejects.toThrow();

    const ok = await downloadStored({
      id,
      linkSecret: "s",
      passphrase: "hunter2",
      onProgress: () => {},
    });
    expect(await blobToBytes(ok.items[0].blob!)).toEqual(data);
  });

  it("burn-after-download is DEFERRED: download alone does not burn", async () => {
    const slots = installFetchMock();
    const salt = randomBytes(16);
    const data = randomBytes(800);
    const files = [new File([data as BlobPart], "once.bin")];

    const { id } = await uploadStored({
      files,
      linkSecret: "burn-secret",
      salt,
      burn: true,
      onProgress: () => {},
    });
    expect(slots.has(id)).toBe(true);

    const { items, burn } = await downloadStored({
      id,
      linkSecret: "burn-secret",
      onProgress: () => {},
    });
    expect(await blobToBytes(items[0].blob!)).toEqual(data);
    // The download returns the burn intent but MUST NOT burn yet — the
    // recipient hasn't confirmed a save (e.g. could be an in-app browser that
    // fails to save). Reads stay idempotent so they can retry.
    expect(burn).toBe(true);
    expect(slots.has(id)).toBe(true);
  });

  it("burnStored deletes the slot once the recipient confirms a save", async () => {
    const slots = installFetchMock();
    const salt = randomBytes(16);
    const data = randomBytes(800);
    const files = [new File([data as BlobPart], "once.bin")];

    const { id } = await uploadStored({
      files,
      linkSecret: "burn-secret",
      salt,
      burn: true,
      onProgress: () => {},
    });

    const { items, burn } = await downloadStored({
      id,
      linkSecret: "burn-secret",
      onProgress: () => {},
    });
    expect(await blobToBytes(items[0].blob!)).toEqual(data);
    expect(burn).toBe(true);
    // Re-downloading still works (idempotent) before the save is confirmed.
    const again = await downloadStored({
      id,
      linkSecret: "burn-secret",
      onProgress: () => {},
    });
    expect(await blobToBytes(again.items[0].blob!)).toEqual(data);
    expect(slots.has(id)).toBe(true);

    // Now the recipient confirms the save -> burn fires -> slot is gone.
    await burnStored(id);
    expect(slots.has(id)).toBe(false);
  });

  it("resumes an in-memory download via HTTP Range after a mid-stream drop", async () => {
    // First, do a normal upload with the standard mock to get a real encrypted
    // blob + manifest we can serve back.
    const slots = installFetchMock();
    const salt = randomBytes(16);
    const data = randomBytes(5000);
    const files = [new File([data as BlobPart], "resume.bin")];
    const { id } = await uploadStored({
      files,
      linkSecret: "resume-secret",
      salt,
      onProgress: () => {},
    });

    // Grab the stored ciphertext + manifest from the mock, then install a new
    // mock that (a) drops the body stream partway on the FIRST GET, and
    // (b) honors a Range header on the retry to serve the remainder.
    const slot = slots.get(id)!;
    const fullBody = slot.body!;
    const manifestMeta = { manifest: slot.manifest, size: slot.size, burn: false };

    let getCalls = 0;
    const rangeStarts: number[] = [];
    const mock = vi.fn(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const path = new URL(url, "https://x").pathname;
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (path.endsWith("/meta")) {
        return { ok: true, status: 200, json: async () => manifestMeta } as any;
      }
      if (path === `/api/store/${id}`) {
        getCalls += 1;
        const range = headers["Range"];
        const start = range ? parseInt(range.replace(/bytes=(\d+)-/, "$1"), 10) : 0;
        rangeStarts.push(start);
        const first = getCalls === 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // On the first call, emit only half then CLOSE early (a truncated
            // response), so the downloader sees received < expected and resumes
            // with a Range request. On retries, serve the remainder from start.
            const slice = fullBody.subarray(start);
            const cut = first ? Math.floor(slice.length / 2) : slice.length;
            controller.enqueue(slice.subarray(0, cut));
            controller.close();
          },
        });
        return {
          ok: true,
          status: start > 0 ? 206 : 200,
          body: stream,
        } as any;
      }
      return { ok: false, status: 404, text: async () => "nf", json: async () => ({}) } as any;
    });
    vi.stubGlobal("fetch", mock);

    const { items } = await downloadStored({
      id,
      linkSecret: "resume-secret",
      onProgress: () => {},
    });
    expect(await blobToBytes(items[0].blob!)).toEqual(data);
    // It must have taken at least two GETs and resumed from a non-zero offset.
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(Math.max(...rangeStarts)).toBeGreaterThan(0);
  });

  it("streams a single-file transfer straight to disk (mocked picker)", async () => {
    // Mock the File System Access API: capture everything written to "disk".
    const written: number[] = [];
    let closed = false;
    (window as any).showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (d: Uint8Array) => {
          for (const b of d) written.push(b);
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    const salt = randomBytes(16);
    const original = randomBytes(4096);
    const files = [new File([original as BlobPart], "movie.bin")];

    const { id } = await uploadStored({
      files,
      linkSecret: "stream-secret",
      salt,
      onProgress: () => {},
    });

    const result = await downloadStoredToDisk({
      id,
      linkSecret: "stream-secret",
      onProgress: () => {},
    });

    expect(result.savedToDisk).toBe(true);
    expect(closed).toBe(true);
    expect(Uint8Array.from(written)).toEqual(original);

    delete (window as any).showSaveFilePicker;
  });
});
