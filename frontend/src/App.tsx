import { useEffect, useRef, useState } from "react";
import { useTransferSession } from "./hooks/useTransferSession";
import { useInstallPrompt } from "./hooks/useInstallPrompt";
import { useServiceWorker } from "./hooks/useServiceWorker";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { parseInviteFromHash } from "./lib/session";
import { parseSharedContent } from "./lib/share-target";
import {
  clearSharedPayload,
  readSharedPayload,
  sharedTextFromPayload,
  CacheStorageLike,
} from "./lib/share-cache";
import { SenderPanel } from "./components/SenderPanel";
import { ReceiverPanel } from "./components/ReceiverPanel";
import { PasteLink } from "./components/PasteLink";
import { InstallPrompt } from "./components/InstallPrompt";
import { InAppBrowserNotice } from "./components/InAppBrowserNotice";
import { UpdateToast } from "./components/UpdateToast";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";

type Route =
  | { kind: "home" }
  | {
      kind: "receive";
      mode: "live" | "store";
      roomId: string;
      linkSecret?: string;
      requiresPassphrase: boolean;
    };

function readRoute(): Route {
  const parsed = parseInviteFromHash(window.location.hash);
  if (parsed) {
    return {
      kind: "receive",
      mode: parsed.kind,
      roomId: parsed.roomId,
      linkSecret: parsed.linkSecret,
      requiresPassphrase: parsed.requiresPassphrase,
    };
  }
  return { kind: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const { state, startSend, startReceive, startStoreReceive, downloadToDisk, chooseLiveSaveLocation, skipLiveSaveLocation, confirmSaved, confirmSafetyCode, rejectSafetyCode, cancel, reset } =
    useTransferSession();

  const sw = useServiceWorker();
  const online = useOnlineStatus();

  // Content shared INTO the app via the OS share sheet.
  //   - GET text/URL shares arrive as query params (parseSharedContent).
  //   - POST file shares are stashed by the SW; we read them from the cache
  //     when the URL carries ?shared=1 (set by the SW redirect).
  const [sharedText, setSharedText] = useState<string | null>(null);
  const [sharedFiles, setSharedFiles] = useState<File[] | null>(null);
  const sharedConsumed = useRef(false);
  useEffect(() => {
    if (sharedConsumed.current) return;
    sharedConsumed.current = true;

    const params = new URLSearchParams(window.location.search);
    const cleanUrl = () => {
      const clean = window.location.pathname + window.location.hash;
      history.replaceState("", document.title, clean);
    };

    // GET text/URL share.
    const shared = parseSharedContent(window.location.search);
    if (shared) {
      setSharedText(shared.text);
      cleanUrl();
      return;
    }

    // POST file share (SW stashed files, redirected with ?shared=1).
    if (params.get("shared") === "1" && typeof caches !== "undefined") {
      void (async () => {
        try {
          const payload = await readSharedPayload(caches as unknown as CacheStorageLike);
          if (payload) {
            if (payload.files.length > 0) setSharedFiles(payload.files);
            const t = sharedTextFromPayload(payload);
            if (t) setSharedText(t);
            await clearSharedPayload(caches as unknown as CacheStorageLike);
          }
        } catch {
          /* ignore — fall through to a normal launch */
        } finally {
          cleanUrl();
        }
      })();
      return;
    }

    if (params.has("shared")) cleanUrl();
  }, []);

  // A transfer is "done" once we reach a terminal success phase — a nice soft
  // signal, but install UI no longer requires it (we advertise up front).
  const hasSucceeded =
    state?.phase === "complete" || state?.phase === "stored";

  const install = useInstallPrompt({ hasSucceeded, requireSuccess: false });

  // Keep route in sync with hash changes (e.g. user pastes a link).
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goHome = () => {
    reset();
    if (window.location.hash) {
      history.pushState("", document.title, window.location.pathname);
    }
    setRoute({ kind: "home" });
  };

  // Open a pasted invite link by applying its fragment and routing to receive.
  const openPastedLink = (hash: string) => {
    window.location.hash = hash;
    setRoute(readRoute());
  };

  const secureContext =
    typeof window !== "undefined" && window.isSecureContext;

  return (
    <div className="app">
      <Hero
        onHome={goHome}
        isHome={route.kind === "home"}
        showInstall={install.showHeaderButton}
        justInstalled={install.justInstalled}
        onInstall={() => {
          install.requestShow();
          void install.promptInstall();
        }}
      />

      {!secureContext && (
        <div className="warn u-mt-16">
          <span>⚠️</span>
          <span>
            This app requires a secure context (HTTPS). WebRTC and Web Crypto are
            unavailable over plain HTTP except on localhost.
          </span>
        </div>
      )}

      {!online && (
        <div className="warn u-mt-16" role="status">
          <span>📡</span>
          <span>
            You're offline. SecureSend needs a connection to create invites,
            signal peers, and fetch stored transfers. We'll reconnect
            automatically when you're back online.
          </span>
        </div>
      )}

      <InstallPrompt
        visible={install.visible && online}
        canPromptInstall={install.canPromptInstall}
        manualGuide={install.manualGuide}
        isIosNeedsSafari={install.isIosNeedsSafari}
        autoExpandSteps={install.autoExpandSteps}
        onInstall={install.promptInstall}
        onDismiss={install.dismiss}
      />

      {state?.reconnecting && (
        <div className="reconnect-banner">
          <span className="dot dot--live" />
          <span>Reconnecting… keep this tab open. Your transfer will resume automatically.</span>
        </div>
      )}

      {route.kind === "home" ? (
        <>
          <SenderPanel
            state={state}
            onStart={startSend}
            onCancel={cancel}
            onReset={goHome}
            onConfirmSafety={confirmSafetyCode}
            onRejectSafety={rejectSafetyCode}
            initialText={sharedText}
            initialFiles={sharedFiles}
          />
          <PasteLink onOpen={openPastedLink} />
        </>
      ) : (
        <>
          <InAppBrowserNotice />
          <ReceiverPanel
            state={state}
            mode={route.mode}
            roomId={route.roomId}
            linkSecret={route.linkSecret}
            requiresPassphrase={route.requiresPassphrase}
            onJoin={startReceive}
            onStoreJoin={startStoreReceive}
            onDownloadToDisk={downloadToDisk}
            onChooseLiveSave={chooseLiveSaveLocation}
            onSkipLiveSave={skipLiveSaveLocation}
            onSaved={confirmSaved}
            onConfirmSafety={confirmSafetyCode}
            onRejectSafety={rejectSafetyCode}
            onReset={goHome}
          />
        </>
      )}

      <HowItWorks />

      <footer className="footer">
        <p>
          End-to-end encrypted file transfer. Secure by default — files are sent
          directly browser-to-browser and never stored on a server, unless you
          choose "Send for later," where only an encrypted copy we can't read is
          stored briefly and then auto-deleted.
        </p>
      </footer>

      <UpdateToast
        needRefresh={sw.needRefresh}
        offlineReady={sw.offlineReady}
        onUpdate={sw.update}
        onDismiss={sw.dismiss}
      />
    </div>
  );
}
