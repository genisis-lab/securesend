/// <reference lib="webworker" />
/**
 * sw.ts — custom service worker (injectManifest strategy).
 *
 * Responsibilities:
 *   1. Precache the app shell (manifest injected by vite-plugin-pwa).
 *   2. SPA navigation fallback to index.html.
 *   3. Update flow: wait for a SKIP_WAITING message from the page (so we never
 *      auto-reload mid-transfer); the page controls when to activate.
 *   4. Web Share Target (POST): receive shared FILES from the OS share sheet,
 *      stash them in a temporary Cache, and redirect the client into the app.
 *      The page reads the stash directly via the Cache API and clears it.
 *      Files are held only transiently — consistent with our "nothing
 *      persisted" stance for transfer payloads.
 */
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { clientsClaim } from "workbox-core";
import { SHARE_CACHE, SHARE_KEY_PREFIX } from "./lib/share-cache";

declare const self: ServiceWorkerGlobalScope;

// __WB_MANIFEST is replaced at build time with the precache manifest.
precacheAndRoute(self.__WB_MANIFEST);

// Take control of open clients as soon as this SW activates, so the
// share-target fetch handler intercepts POSTs without requiring a reload.
clientsClaim();

// SPA fallback: serve index.html for navigations (so /#/r/... links work),
// EXCEPT the share-target endpoint, which we handle explicitly below.
const navHandler = createHandlerBoundToURL("index.html");
registerRoute(
  new NavigationRoute(navHandler, {
    denylist: [/\/share-target/],
  }),
);

// ---- Update flow: page asks us to activate the waiting worker ----
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

// ---- Web Share Target (POST multipart/form-data with files) ----
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
  }
});

/**
 * Receive shared files/text, stash them in a cache, and redirect the client
 * into the app at `/?shared=1` so the page picks up the payload.
 */
async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((v): v is File => v instanceof File);
    const title = (form.get("title") as string) || "";
    const text = (form.get("text") as string) || "";
    const urlField = (form.get("url") as string) || "";

    const cache = await caches.open(SHARE_CACHE);

    // Clear any stale payload from a previous share.
    for (const key of await cache.keys()) {
      if (new URL(key.url).pathname.startsWith(SHARE_KEY_PREFIX)) {
        await cache.delete(key);
      }
    }

    // Stash metadata (text fields) as JSON.
    const meta = { title, text, url: urlField, fileCount: files.length };
    await cache.put(
      `${SHARE_KEY_PREFIX}/meta`,
      new Response(JSON.stringify(meta), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Stash each file as its own cache entry, carrying its name in a header.
    await Promise.all(
      files.map((file, i) =>
        cache.put(
          `${SHARE_KEY_PREFIX}/file/${i}`,
          new Response(file, {
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "X-Share-Filename": encodeURIComponent(file.name),
            },
          }),
        ),
      ),
    );

    return Response.redirect("/?shared=1", 303);
  } catch {
    // On failure, just send the user to the app empty-handed.
    return Response.redirect("/?shared=0", 303);
  }
}
