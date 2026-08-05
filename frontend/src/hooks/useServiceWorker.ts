import { useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

export interface ServiceWorkerState {
  /** A new version is waiting; calling `update()` activates it and reloads. */
  needRefresh: boolean;
  /** Activate the waiting SW and reload to the new version. */
  update: () => void;
  /** Dismiss the update notice without updating. */
  dismiss: () => void;
}

/**
 * Wraps vite-plugin-pwa's `registerSW` so the UI can show a non-disruptive
 * "Update available" toast.
 *
 * We intentionally use the plugin's `prompt` mode (set in vite.config.ts)
 * instead of `autoUpdate`: auto-reloading the page to apply an update could
 * interrupt an in-flight P2P transfer. Letting the user choose when to refresh
 * keeps transfers safe.
 */
export function useServiceWorker(): ServiceWorkerState {
  const [needRefresh, setNeedRefresh] = useState(false);
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
    });
    // Stash the updater so the button can call it (true = reload after activate).
    setUpdateFn(() => () => updateSW(true));
  }, []);

  return {
    needRefresh,
    update: () => {
      void updateFn?.();
      setNeedRefresh(false);
    },
    dismiss: () => {
      setNeedRefresh(false);
    },
  };
}
