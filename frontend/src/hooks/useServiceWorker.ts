import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

export interface ServiceWorkerState {
  /** A new version is waiting; calling `update()` activates it and reloads. */
  needRefresh: boolean;
  /** The app shell has been cached and is ready to work offline. */
  offlineReady: boolean;
  /** Activate the waiting SW and reload to the new version. */
  update: () => void;
  /** Dismiss the current notice (e.g. offline-ready) without updating. */
  dismiss: () => void;
}

/**
 * Wraps vite-plugin-pwa's `registerSW`.
 *
 * Hotfix behavior: apply newly deployed app-shell updates immediately. This
 * avoids users being stuck on an old cached PWA shell after a Cloudflare Pages
 * deploy (for example, missing a newly-added receiver button). The update still
 * only happens when the browser discovers a new service worker; active transfer
 * data is never cached by the service worker.
 */
export function useServiceWorker(): ServiceWorkerState {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateFn, setUpdateFn] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // No-op during SSR / tests without a SW container.
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Activate the waiting service worker and reload into the new app shell
        // right away, so the UI a user sees matches the latest deployment.
        setNeedRefresh(true);
        void updateSW(true);
      },
      onOfflineReady() {
        setOfflineReady(true);
      },
    });

    // Stash the updater so the toast button can still call it if needed.
    setUpdateFn(() => () => updateSW(true));
  }, []);

  return {
    needRefresh,
    offlineReady,
    update: () => {
      void updateFn?.();
      setNeedRefresh(false);
    },
    dismiss: () => {
      setNeedRefresh(false);
      setOfflineReady(false);
    },
  };
}
