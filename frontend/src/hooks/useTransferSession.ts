import { useCallback, useEffect, useRef, useState } from "react";
import {
  SessionState,
  TransferSession,
} from "../lib/session";

/**
 * React binding for the framework-agnostic TransferSession. Owns the session
 * instance lifecycle and exposes its reactive state plus action callbacks.
 */
export function useTransferSession() {
  const sessionRef = useRef<TransferSession | null>(null);
  const [state, setState] = useState<SessionState | null>(null);

  // Lazily create the session on first use and subscribe to its updates.
  const ensureSession = useCallback((): TransferSession => {
    if (!sessionRef.current) {
      const s = new TransferSession();
      sessionRef.current = s;
      s.subscribe(setState);
    }
    return sessionRef.current;
  }, []);

  const startSend = useCallback(
    (
      files: File | File[],
      passphrase?: string,
      ttlSeconds?: number,
      mode: "live" | "store" = "live",
      burn = false,
    ) => {
      return ensureSession().startSend(files, passphrase, ttlSeconds, mode, burn);
    },
    [ensureSession],
  );

  const startReceive = useCallback(
    (roomId: string, linkSecret?: string, passphrase?: string) => {
      return ensureSession().startReceive(roomId, linkSecret, passphrase);
    },
    [ensureSession],
  );

  const startStoreReceive = useCallback(
    (storeId: string, linkSecret?: string, passphrase?: string) => {
      return ensureSession().startStoreReceive(storeId, linkSecret, passphrase);
    },
    [ensureSession],
  );

  const downloadToDisk = useCallback(() => {
    return sessionRef.current?.downloadToDisk();
  }, []);

  const chooseLiveSaveLocation = useCallback(() => {
    return sessionRef.current?.chooseLiveSaveLocation();
  }, []);

  const skipLiveSaveLocation = useCallback(() => {
    sessionRef.current?.skipLiveSaveLocation();
  }, []);

  const confirmSaved = useCallback(() => {
    sessionRef.current?.confirmSaved();
  }, []);

  const confirmSafetyCode = useCallback(() => {
    sessionRef.current?.confirmSafetyCode();
  }, []);

  const rejectSafetyCode = useCallback(() => {
    sessionRef.current?.rejectSafetyCode();
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current?.cancel();
  }, []);

  const reset = useCallback(() => {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    setState(null);
  }, []);

  // Tear down on unmount to close sockets / WebRTC and wipe key material.
  useEffect(() => {
    return () => {
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, []);

  return {
    state,
    startSend,
    startReceive,
    startStoreReceive,
    downloadToDisk,
    chooseLiveSaveLocation,
    skipLiveSaveLocation,
    confirmSaved,
    confirmSafetyCode,
    rejectSafetyCode,
    cancel,
    reset,
  };
}
