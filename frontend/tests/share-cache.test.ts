import { describe, it, expect } from "vitest";
import {
  SHARE_CACHE,
  SHARE_KEY_PREFIX,
  readSharedPayload,
  clearSharedPayload,
  sharedTextFromPayload,
  CacheStorageLike,
  CacheLike,
} from "../src/lib/share-cache";

/** A tiny in-memory Cache/CacheStorage fake backed by a Map of Responses. */
function fakeCacheStorage(seed: Record<string, Response> = {}): {
  storage: CacheStorageLike;
  raw: Map<string, Response>;
} {
  const raw = new Map<string, Response>(Object.entries(seed));
  const cache: CacheLike = {
    async match(req) {
      return raw.get(req);
    },
    async keys() {
      return [...raw.keys()].map((url) => ({ url: `https://app.test${url}` }));
    },
    async delete(req) {
      const url = typeof req === "string" ? req : new URL(req.url).pathname;
      return raw.delete(url);
    },
  };
  return { storage: { open: async () => cache }, raw };
}

function metaResponse(meta: object): Response {
  return new Response(JSON.stringify(meta), {
    headers: { "Content-Type": "application/json" },
  });
}

function fileResponse(content: string, name: string, type = "text/plain"): Response {
  return new Response(content, {
    headers: {
      "Content-Type": type,
      "X-Share-Filename": encodeURIComponent(name),
    },
  });
}

describe("readSharedPayload", () => {
  it("returns null when nothing is stashed", async () => {
    const { storage } = fakeCacheStorage();
    expect(await readSharedPayload(storage)).toBeNull();
  });

  it("reads metadata and reconstructs files with names", async () => {
    const { storage } = fakeCacheStorage({
      [`${SHARE_KEY_PREFIX}/meta`]: metaResponse({
        title: "Hi",
        text: "note",
        url: "",
        fileCount: 2,
      }),
      [`${SHARE_KEY_PREFIX}/file/0`]: fileResponse("hello", "a.txt"),
      [`${SHARE_KEY_PREFIX}/file/1`]: fileResponse("world", "b.txt", "text/markdown"),
    });

    const payload = await readSharedPayload(storage);
    expect(payload).not.toBeNull();
    expect(payload!.title).toBe("Hi");
    expect(payload!.text).toBe("note");
    expect(payload!.files).toHaveLength(2);
    expect(payload!.files[0].name).toBe("a.txt");
    expect(payload!.files[0].size).toBe(5); // "hello"
    expect(payload!.files[1].name).toBe("b.txt");
    expect(payload!.files[1].type).toBe("text/markdown");
  });

  it("tolerates a missing file entry without throwing", async () => {
    const { storage } = fakeCacheStorage({
      [`${SHARE_KEY_PREFIX}/meta`]: metaResponse({ fileCount: 2 }),
      [`${SHARE_KEY_PREFIX}/file/0`]: fileResponse("only one", "a.txt"),
      // file/1 intentionally absent
    });
    const payload = await readSharedPayload(storage);
    expect(payload!.files).toHaveLength(1);
  });

  it("returns null on corrupt metadata JSON", async () => {
    const { storage } = fakeCacheStorage({
      [`${SHARE_KEY_PREFIX}/meta`]: new Response("{bad json", {
        headers: { "Content-Type": "application/json" },
      }),
    });
    expect(await readSharedPayload(storage)).toBeNull();
  });
});

describe("clearSharedPayload", () => {
  it("removes all share-prefixed entries", async () => {
    const { storage, raw } = fakeCacheStorage({
      [`${SHARE_KEY_PREFIX}/meta`]: metaResponse({ fileCount: 1 }),
      [`${SHARE_KEY_PREFIX}/file/0`]: fileResponse("x", "x.txt"),
    });
    await clearSharedPayload(storage);
    expect(raw.size).toBe(0);
  });
});

describe("sharedTextFromPayload", () => {
  it("joins non-empty fields and de-duplicates", () => {
    expect(
      sharedTextFromPayload({
        title: "T",
        text: "body",
        url: "https://x.test",
        files: [],
      }),
    ).toBe("T\nbody\nhttps://x.test");
  });

  it("drops empties and dupes", () => {
    expect(
      sharedTextFromPayload({
        title: "",
        text: "same",
        url: "same",
        files: [],
      }),
    ).toBe("same");
  });
});

it("exports the expected cache name", () => {
  expect(SHARE_CACHE).toBe("securesend-shared-v1");
});
