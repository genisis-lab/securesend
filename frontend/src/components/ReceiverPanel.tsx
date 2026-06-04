import { useEffect, useMemo, useState } from "react";
import { SessionState } from "../lib/session";
import { TransferProgressView } from "./TransferProgress";
import { ReceivedFileItem } from "./ReceivedFileItem";
import { ConnectionBadge } from "./ConnectionBadge";
import { SafetyCheck } from "./SafetyCheck";

interface Props {
  state: SessionState | null;
  mode: "live" | "store";
  roomId: string;
  linkSecret?: string;
  requiresPassphrase: boolean;
  onJoin: (roomId: string, linkSecret?: string, passphrase?: string) => void;
  onStoreJoin: (storeId: string, linkSecret?: string, passphrase?: string) => void;
  onDownloadToDisk: () => void;
  /** Live mode: pick a save location to stream a large file straight to disk. */
  onChooseLiveSave?: () => void;
  /** Live mode: skip streaming-to-disk and receive into memory instead. */
  onSkipLiveSave?: () => void;
  /** Called when the recipient confirms a save (fires deferred burn-after-download). */
  onSaved?: () => void;
  /** Confirm the displayed safety code matches the sender's. */
  onConfirmSafety: () => void;
  /** Report that the safety codes don't match (aborts the transfer). */
  onRejectSafety: () => void;
  onReset: () => void;
}

/** The "receive" flow: join room -> exchange keys -> receive -> save. */
export function ReceiverPanel({
  state,
  mode,
  roomId,
  linkSecret,
  requiresPassphrase,
  onJoin,
  onStoreJoin,
  onDownloadToDisk,
  onChooseLiveSave,
  onSkipLiveSave,
  onSaved,
  onConfirmSafety,
  onRejectSafety,
  onReset,
}: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [joined, setJoined] = useState(false);

  const phase = state?.phase ?? "idle";
  const statusText = useMemo(() => receiverStatus(phase), [phase]);
  const received = state?.receivedFiles ?? [];

  const join = (pass?: string) => {
    if (mode === "store") onStoreJoin(roomId, linkSecret, pass);
    else onJoin(roomId, linkSecret, pass);
  };

  // Auto-join if no passphrase is required.
  useEffect(() => {
    if (!requiresPassphrase && !joined) {
      setJoined(true);
      join();
    }
    // Intentionally only re-run when the invite identity changes; `join` is a
    // stable session action. (react-hooks/exhaustive-deps is not configured.)
  }, [requiresPassphrase, joined, roomId, linkSecret, mode]);

  const handleJoin = () => {
    setJoined(true);
    join(requiresPassphrase ? passphrase : undefined);
  };

  // ---- Safety-code verification (machine-in-the-middle defense) ----
  if (phase === "verifying") {
    return (
      <SafetyCheck
        code={state?.fingerprint ?? null}
        peerLabel="the sender"
        confirmLabel="Codes match — receive"
        onConfirm={onConfirmSafety}
        onReject={onRejectSafety}
      />
    );
  }

  // ---- Ready to save (streaming-to-disk; needs a user gesture) ----
  if (phase === "ready-to-save") {
    // Live mode streams an incoming P2P file; store mode fetches a stored blob.
    const live = mode === "live";
    return (
      <div className="card">
        <div className="success-icon">⬇️</div>
        <h2 className="card__title u-center">
          {live ? "Large file incoming" : "Ready to download"}
        </h2>
        <p className="card__hint u-center">
          This file streams straight to your disk as it {live ? "arrives" : "decrypts"},
          so even very large files won't fill your device's memory. Click below
          and choose where to save it.
        </p>
        <button
          className="btn btn--block"
          onClick={live ? onChooseLiveSave : onDownloadToDisk}
        >
          ⬇ Choose location &amp; save
        </button>
        {live && onSkipLiveSave && (
          <button
            className="btn btn--ghost btn--block u-mt-10"
            onClick={onSkipLiveSave}
          >
            Receive into memory instead
          </button>
        )}
        <button
          className="btn btn--ghost btn--block u-mt-10"
          onClick={onReset}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ---- Completed, streamed straight to disk (no in-memory preview) ----
  if (phase === "complete" && state?.savedToDisk) {
    return (
      <div className="card">
        <div className="success-icon">✅</div>
        <h2 className="card__title u-center">
          Saved to your device
        </h2>
        <p className="card__hint u-center">
          The file was decrypted and written straight to the location you chose.
        </p>
        <button className="btn btn--block" onClick={onReset}>
          Done
        </button>
      </div>
    );
  }

  // ---- Completed: offer downloads ----
  if (phase === "complete" && received.length > 0) {
    const single = received.length === 1;
    return (
      <div className="card">
        <div className="success-icon">📥</div>
        <h2 className="card__title u-center">
          {single ? "Received & decrypted" : `${received.length} items received`}
        </h2>
        <div className="received-list">
          {received.map((item, i) => (
            <ReceivedFileItem
              key={`${item.meta.name}:${i}`}
              item={item}
              autoSave={single}
              onSaved={onSaved}
            />
          ))}
        </div>
        <button
          className="btn btn--ghost btn--block u-mt-14"
          onClick={onReset}
        >
          Done
        </button>
      </div>
    );
  }

  // ---- Error / expired / peer-left / cancelled ----
  if (
    phase === "error" ||
    phase === "expired" ||
    phase === "peer-left" ||
    phase === "cancelled"
  ) {
    const title =
      phase === "expired"
        ? "Invite expired"
        : phase === "peer-left"
          ? "Sender disconnected"
          : phase === "cancelled"
            ? "Transfer cancelled"
            : "Something went wrong";
    return (
      <div className="card">
        <h2 className="card__title">{title}</h2>
        <p className={phase === "cancelled" ? "card__hint" : "error-text"} role="alert">
          {phase === "cancelled"
            ? "The sender cancelled this transfer."
            : state?.error ??
              (phase === "expired"
                ? "This invite link has expired."
                : "The sender left before the transfer finished. They may need to create a new invite.")}
        </p>
        <button className="btn btn--block u-mt-16" onClick={onReset}>
          Back to home
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card__title">You've been invited to receive files</h2>
      <p className="card__hint">
        They'll be decrypted in your browser after a direct, encrypted
        peer-to-peer connection is established with the sender. Keep this tab
        open until it finishes.
      </p>

      {requiresPassphrase && !joined && (
        <>
          <label className="label">
            This invite is passphrase-protected. Enter the passphrase the sender
            shared with you:
          </label>
          <input
            className="input"
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
          />
          <button
            className="btn btn--block u-mt-18"
            onClick={handleJoin}
            disabled={passphrase.length < 4}
          >
            Join secure transfer
          </button>
        </>
      )}

      {phase === "transferring" || phase === "downloading" ? (
        <>
          <TransferProgressView
            progress={state?.progress ?? null}
            label={phase === "downloading" ? "Downloading & decrypting…" : "Receiving & decrypting…"}
          />
          {phase === "transferring" && (
            <ConnectionBadge type={state?.connectionType ?? null} />
          )}
        </>
      ) : (
        joined && (
          <>
            {mode === "live" && state?.fingerprint && (
              <p className="card__hint u-mt-14">
                Your safety code:{" "}
                <span className="fingerprint">{state.fingerprint}</span>
                <br />
                For maximum security, compare this with the sender over a trusted
                channel — it should match exactly on both screens.
              </p>
            )}
            <div className="status u-mt-14" role="status" aria-live="polite">
              <span className="dot dot--live" /> {statusText}
            </div>
          </>
        )
      )}
    </div>
  );
}

function receiverStatus(phase: string): string {
  switch (phase) {
    case "downloading":
      return "Downloading your files…";
    case "waiting-for-peer":
      return "Connecting to the sender…";
    case "peer-connected":
      return "Connected. Exchanging keys…";
    case "key-exchange":
      return "Performing ECDH key exchange…";
    case "connecting-webrtc":
      return "Establishing peer-to-peer connection…";
    default:
      return "Working…";
  }
}
