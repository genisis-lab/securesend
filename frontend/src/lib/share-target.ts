/**
 * share-target.ts — parse content shared INTO SecureSend via the Web Share
 * Target API.
 *
 * We register a GET-based `share_target` in the manifest (see vite.config.ts).
 * When the user picks "SecureSend" from the OS share sheet for a link or text,
 * the browser opens the app at:
 *
 *   /?title=<t>&text=<x>&url=<u>
 *
 * GET share targets carry only text/URLs (not file blobs); a file POST share
 * target would require a custom service-worker fetch handler and is tracked as
 * a follow-up. This parser turns the query params into a single text payload
 * the sender can pre-fill into the Text tab.
 */

export interface SharedContent {
  /** Combined text to pre-fill (title + text + url, de-duped and trimmed). */
  text: string;
}

/**
 * Parse shared content from a URL query string (e.g. `location.search`).
 * Returns null if this navigation isn't a share-target launch or carries no
 * usable text.
 *
 * We treat the navigation as a share launch when any of the share params
 * (title/text/url) is present. Ordinary launches only carry `?source=...`
 * (see the manifest's start_url / shortcuts), so they won't be mistaken for a
 * share.
 */
export function parseSharedContent(search: string): SharedContent | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return null;
  }

  const parts: string[] = [];
  for (const key of ["title", "text", "url"] as const) {
    const v = params.get(key);
    if (v && v.trim().length > 0) parts.push(v.trim());
  }
  if (parts.length === 0) return null; // not a share launch
  // De-duplicate (apps often send the same value as both text and url).
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const text = unique.join("\n").trim();
  if (text.length === 0) return null;
  return { text };
}
