import { useEffect, useState } from "react";

/**
 * Tracks the browser's online/offline status via the `online`/`offline`
 * events. SecureSend needs a live network for signaling and for fetching
 * stored blobs, so a clear offline indicator avoids confusing failures.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
