/**
 * share-cache.ts — shared constants + client-side reader for files received
 * via the POST Web Share Target.
 *
 * The service worker (src/sw.ts) stashes shared files in a Cache; the page
 * reads them back here, reconstructs File objects, and clears the stash so
 * nothing lingers. Both sides import the same key constants to stay in sync.
 */

/** Cache name where the SW stashes shared files between SW and page. */
export const SHARE_CACHE = "securesend-shared-v1";
/** Key prefix for all stashed share entries. */
export const SHARE_KEY_PREFIX = "/__shared-payload";

export interface SharedPayload {
  title: string;
  text: string;
  url: string;
  files: File[];
}

/** Minimal CacheStorage surface so this is unit-testable with a fake. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  keys(): Promise<readonly { url: string }[]>;
  delete(request: string | { url: string }): Promise<boolean>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

/**
 * Read the shared payload (metadata + files) stashed by the service worker.
 * Returns null if there's nothing stashed. Reconstructs File objects with
 * their original names/types where available.
 */
export async function readSharedPayload(
  storage: CacheStorageLike,
): Promise<SharedPayload | null> {
  const cache = await storage.open(SHARE_CACHE);
  const metaRes = await cache.match(`${SHARE_KEY_PREFIX}/meta`);
  if (!metaRes) return null;

  let meta: { title?: string; text?: string; url?: string; fileCount?: number };
  try {
    meta = (await metaRes.json()) as typeof meta;
  } catch {
    return null;
  }

  const count = typeof meta.fileCount === "number" ? meta.fileCount : 0;
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const res = await cache.match(`${SHARE_KEY_PREFIX}/file/${i}`);
    if (!res) continue;
    const blob = await res.blob();
    const nameHeader = res.headers.get("X-Share-Filename");
    const name = nameHeader ? decodeURIComponent(nameHeader) : `shared-${i}`;
    const type = res.headers.get("Content-Type") || blob.type || "application/octet-stream";
    files.push(new File([blob], name, { type }));
  }

  return {
    title: meta.title ?? "",
    text: meta.text ?? "",
    url: meta.url ?? "",
    files,
  };
}

/** Remove the stashed payload so it isn't re-consumed or left lingering. */
export async function clearSharedPayload(
  storage: CacheStorageLike,
): Promise<void> {
  const cache = await storage.open(SHARE_CACHE);
  for (const key of await cache.keys()) {
    try {
      const path = new URL(key.url).pathname;
      if (path.startsWith(SHARE_KEY_PREFIX)) await cache.delete(key);
    } catch {
      /* ignore malformed keys */
    }
  }
}

/** Combine shared text fields into a single pre-fill string (de-duplicated). */
export function sharedTextFromPayload(p: SharedPayload): string {
  const parts = [p.title, p.text, p.url]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  return parts
    .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
    .join("\n")
    .trim();
}
