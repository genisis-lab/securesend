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
 * Wraps vite-plugin-pwa's `registerSW` so the UI can show a non-disruptive
 * "Update available" toast and an "Offline ready" confirmation.
 *
 * We intentionally use the plugin's `prompt` mode (set in vite.config.ts)
 * instead of `autoUpdate`: auto-reloading the page to apply an update could
 * interrupt an in-flight P2P transfer. Letting the user choose when to refresh
 * keeps transfers safe.
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
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onOfflineReady() {
        setOfflineReady(true);
      },
    });
    // Stash the updater so the button can call it (true = reload after activate).
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
