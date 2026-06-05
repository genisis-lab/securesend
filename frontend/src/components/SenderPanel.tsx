import { useEffect, useMemo, useState } from "react";
import { SessionState } from "../lib/session";
import { FileDropzone } from "./FileDropzone";
import { InviteLink } from "./InviteLink";
import { TransferProgressView } from "./TransferProgress";
import { ConnectionBadge } from "./ConnectionBadge";
import { formatBytes, formatEta } from "../lib/format";
import { textToFile, LARGE_FILE_WARN_BYTES } from "../lib/download";

interface Props {
  state: SessionState | null;
  onStart: (
    files: File[],
    passphrase?: string,
    ttlSeconds?: number,
    mode?: "live" | "store",
    burn?: boolean,
  ) => void;
  onCancel: () => void;
  onReset: () => void;
  /** Pre-filled text (e.g. from the OS share sheet). Opens the Text tab. */
  initialText?: string | null;
  /** Pre-filled files (e.g. shared into the app). Opens the Files tab. */
  initialFiles?: File[] | null;
}

/**
 * Invite expiry options. A shorter window is safer (less time for a leaked
 * link to be abused); a longer one is more convenient when the recipient may
 * be slow to open it. 10 minutes is a sensible default balance.
 */
const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: "5 minutes", seconds: 5 * 60 },
  { label: "10 minutes (recommended)", seconds: 10 * 60 },
  { label: "30 minutes", seconds: 30 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "12 hours", seconds: 12 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
];
const DEFAULT_EXPIRY_SECONDS = 10 * 60;
const ESTIMATED_UPLOAD_BYTES_PER_SECOND = 1_250_000; // 10 Mbps

type Mode = "files" | "text";

const PASSPHRASE_WORDS = [
  "anchor",
  "bright",
  "copper",
  "delta",
  "ember",
  "forest",
  "glide",
  "harbor",
  "ivory",
  "juno",
  "kernel",
  "lunar",
  "mesa",
  "nova",
  "orbit",
  "prairie",
  "quartz",
  "river",
  "summit",
  "tango",
  "umber",
  "velvet",
  "willow",
  "zenith",
];

/** The "send" flow: pick files/text -> create invite -> wait -> transfer. */
export function SenderPanel({ state, onStart, onCancel, onReset, initialText, initialFiles }: Props) {
  const [mode, setMode] = useState<Mode>(initialText ? "text" : "files");
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [text, setText] = useState(initialText ?? "");
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(DEFAULT_EXPIRY_SECONDS);
  const [deliveryMode, setDeliveryMode] = useState<"live" | "store">("live");
  const [burnAfter, setBurnAfter] = useState(false);
  const [fileNote, setFileNote] = useState("");

  // When content is shared into the app after mount, drop it into the right tab.
  useEffect(() => {
    if (initialText && initialText.length > 0) {
      setMode("text");
      setText(initialText);
    }
  }, [initialText]);

  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) {
      setMode("files");
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
        const merged = [...prev];
        for (const f of initialFiles) {
          const key = `${f.name}:${f.size}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(f);
          }
        }
        return merged;
      });
    }
  }, [initialFiles]);

  const phase = state?.phase ?? "idle";
  const started = phase !== "idle" && state?.role === "initiator";

  const statusText = useMemo(() => senderStatus(phase), [phase]);
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  const tooLarge = totalSize > LARGE_FILE_WARN_BYTES;
  const estimatedUploadTime =
    totalSize > 0 ? formatEta(totalSize / ESTIMATED_UPLOAD_BYTES_PER_SECOND) : "—";
  const passphraseStrength = describePassphrase(passphrase);

  const addFiles = (incoming: File[]) => {
    // De-dupe by name+size so re-dropping doesn't double-add.
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const merged = [...prev];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(f);
        }
      }
      return merged;
    });
  };

  const removeFile = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));

  const moveFile = (idx: number, direction: -1 | 1) => {
    setFiles((prev) => {
      const nextIndex = idx + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [file] = next.splice(idx, 1);
      next.splice(nextIndex, 0, file);
      return next;
    });
  };

  const renameFile = (idx: number, name: string) => {
    setFiles((prev) =>
      prev.map((file, i) => (i === idx ? copyFileWithName(file, name) : file)),
    );
  };

  const resetLocal = () => {
    setFiles([]);
    setText("");
    setFileNote("");
    onReset();
  };

  const handleCreate = () => {
    const note = fileNote.trim();
    const payload =
      mode === "text"
        ? [textToFile(text)]
        : note
          ? [...files, textToFile(note)]
          : files;
    if (payload.length === 0) return;
    onStart(
      payload,
      usePassphrase ? passphrase : undefined,
      expirySeconds,
      deliveryMode,
      deliveryMode === "store" ? burnAfter : false,
    );
  };

  const canCreate =
    (mode === "files" ? files.length > 0 : text.trim().length > 0) &&
    (!usePassphrase || passphrase.length >= 4);

  const generatePassphrase = () => {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    setPassphrase(
      Array.from(bytes, (byte) => PASSPHRASE_WORDS[byte % PASSPHRASE_WORDS.length]).join("-"),
    );
  };

  // ---- Store-and-forward: uploaded, ready to share (sender can leave) ----
  if (phase === "stored" && state?.inviteUrl) {
    return (
      <div className="card">
        <div className="success-icon">📦</div>
        <h2 className="card__title u-center">
          Ready to share
        </h2>
        <p className="card__hint u-center">
          Your {state.itemCount > 1 ? `${state.itemCount} files are` : "file is"}{" "}
          encrypted and stored. Send this link — your recipient can download it
          anytime before it expires. <strong>You can close this tab now.</strong>
        </p>
        <div className="audit-panel u-mt-14">
          <div className="audit-panel__row">
            <strong>Delivery receipt</strong>
            <span>Upload complete. Download confirmation happens on the recipient's device.</span>
          </div>
          <div className="audit-panel__row">
            <strong>Stored mode</strong>
            <span>{burnAfter ? "One-time retrieval is on." : "Auto-delete at expiry."}</span>
          </div>
        </div>
        <InviteLink url={state.inviteUrl} expiresAt={state.expiresAt ?? null} />
        <button className="btn btn--ghost btn--block u-mt-14" onClick={resetLocal}>
          Send something else
        </button>
      </div>
    );
  }

  // ---- Completed ----
  if (phase === "complete" && state?.role === "initiator") {
    const count = state.itemCount;
    return (
      <div className="card">
        <div className="success-icon">✅</div>
        <h2 className="card__title u-center">
          {state.delivered ? "Delivered securely" : "Sent securely"}
        </h2>
        <p className="card__hint u-center">
          {count > 1 ? `${count} items were` : "Your item was"} encrypted
          end-to-end and {state.delivered ? "confirmed received by your recipient" : "sent"}{" "}
          peer-to-peer. The room is destroyed and keys cleared from memory.
        </p>
        <div className="audit-panel u-mt-14">
          <div className="audit-panel__row">
            <strong>Delivery receipt</strong>
            <span>{state.delivered ? "Receiver acknowledged the full transfer." : "Sent without final acknowledgement."}</span>
          </div>
          <div className="audit-panel__row">
            <strong>Mode</strong>
            <span>Live peer-to-peer</span>
          </div>
        </div>
        <button className="btn btn--block" onClick={resetLocal}>
          Send something else
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
          ? "Peer disconnected"
          : phase === "cancelled"
            ? "Transfer cancelled"
            : "Something went wrong";
    return (
      <div className="card">
        <h2 className="card__title">{title}</h2>
        <p className={phase === "cancelled" ? "card__hint" : "error-text"} role="alert">
          {phase === "cancelled"
            ? "You cancelled the transfer. You can start a new one anytime."
            : state?.error ??
              (phase === "expired"
                ? "The invite link expired before the transfer completed."
                : "The other peer left before the transfer finished. Check both devices are online, then start again.")}
        </p>
        <button className="btn btn--block u-mt-16" onClick={resetLocal}>
          Start over
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="card__title">Send files or text</h2>
      <p className="card__hint">
        Everything is encrypted in your browser before it leaves your device.
        By default it's sent directly to your recipient and never stored on a
        server — or choose <strong>Send for later</strong> below to park an
        encrypted copy so they can grab it anytime.
      </p>

      {!started && (
        <div className="tabs" role="tablist">
          <button
            className={`tab ${mode === "files" ? "tab--active" : ""}`}
            role="tab"
            aria-selected={mode === "files"}
            onClick={() => setMode("files")}
          >
            📎 Files
          </button>
          <button
            className={`tab ${mode === "text" ? "tab--active" : ""}`}
            role="tab"
            aria-selected={mode === "text"}
            onClick={() => setMode("text")}
          >
            📝 Text
          </button>
        </div>
      )}

      {/* FILES MODE */}
      {mode === "files" && !started && (
        <>
          <div className="u-mt-14">
            <FileDropzone onFiles={addFiles} disabled={started} />
          </div>

          {files.length > 0 && (
            <div className="file-list">
              {files.map((f, i) => (
                <div className="file-pill file-pill--editable" key={`${f.name}:${f.size}:${i}`}>
                  <div className="file-pill__meta">
                    <input
                      className="input input--compact"
                      value={f.name}
                      aria-label={`Rename ${f.name}`}
                      onChange={(e) => renameFile(i, e.target.value)}
                    />
                    <div className="file-pill__size">
                      {formatBytes(f.size)} · {f.type || "unknown type"}
                    </div>
                  </div>
                  <div className="file-actions">
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => moveFile(i, -1)}
                      disabled={i === 0}
                    >
                      Move up
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => moveFile(i, 1)}
                      disabled={i === files.length - 1}
                    >
                      Move down
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => removeFile(i)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div className="file-list__total">
                {files.length} item{files.length > 1 ? "s" : ""} ·{" "}
                {formatBytes(totalSize)} total · about {estimatedUploadTime} at 10 Mbps
              </div>
              <label className="label" htmlFor="file-note">
                Optional message
              </label>
              <textarea
                id="file-note"
                className="input textarea textarea--compact"
                placeholder="Add a note that arrives as a small text file."
                value={fileNote}
                onChange={(e) => setFileNote(e.target.value)}
                rows={3}
              />
            </div>
          )}

          {tooLarge && (
            <div className="warn">
              <span>⚠️</span>
              <span>
                That's a large amount of data ({formatBytes(totalSize)}). The
                recipient's device assembles the file in memory, so very large
                transfers may fail on phones or low-memory devices.
              </span>
            </div>
          )}
        </>
      )}

      {/* TEXT MODE */}
      {mode === "text" && !started && (
        <>
          <label className="label" htmlFor="text-input">
            Text / message to send
          </label>
          <textarea
            id="text-input"
            className="input textarea"
            placeholder="Paste a password, address, note… it's encrypted end-to-end."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
          />
        </>
      )}

      {/* Options (only before starting, with something to send) */}
      {!started && (mode === "files" ? files.length > 0 : text.trim().length > 0) && (
        <>
          <label className="label">Delivery method</label>
          <div className="mode-options">
            <button
              type="button"
              className={`mode-option ${deliveryMode === "live" ? "mode-option--active" : ""}`}
              onClick={() => setDeliveryMode("live")}
              aria-pressed={deliveryMode === "live"}
            >
              <div className="mode-option__title">⚡ Live (most private)</div>
              <div className="mode-option__desc">
                Sent directly device-to-device. Nothing is ever stored on a
                server. You and the recipient must both keep the app open at the
                same time.
              </div>
            </button>
            <button
              type="button"
              className={`mode-option ${deliveryMode === "store" ? "mode-option--active" : ""}`}
              onClick={() => setDeliveryMode("store")}
              aria-pressed={deliveryMode === "store"}
            >
              <div className="mode-option__title">📦 Send for later</div>
              <div className="mode-option__desc">
                Encrypted in your browser, then parked on the server so your
                recipient can download anytime — you can close the app once it
                uploads. The server only ever holds scrambled data it can't read,
                and it's auto-deleted after the link expires.
              </div>
            </button>
          </div>

          <label className="label" htmlFor="expiry-select">
            {deliveryMode === "store" ? "Stored copy expires after" : "Invite link expires after"}
          </label>
          <select
            id="expiry-select"
            className="input"
            value={expirySeconds}
            onChange={(e) => setExpirySeconds(Number(e.target.value))}
            disabled={deliveryMode === "store"}
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <option key={opt.seconds} value={opt.seconds}>
                {opt.label}
              </option>
            ))}
          </select>
          {deliveryMode === "store" && (
            <p className="card__hint u-mt-6">
              Stored transfers expire automatically (typically 24 hours), then
              the encrypted copy is permanently deleted.
            </p>
          )}

          {deliveryMode === "store" && (
            <label className="label">
              <input className="u-mr-8"
                type="checkbox"
                checked={burnAfter}
                onChange={(e) => setBurnAfter(e.target.checked)}
              />
              Burn after download — delete the stored copy the moment your
              recipient downloads it (one-time retrieval).
            </label>
          )}

          <label className="label">
            <input className="u-mr-8"
              type="checkbox"
              checked={usePassphrase}
              onChange={(e) => setUsePassphrase(e.target.checked)}
            />
            Protect with a passphrase (recommended)
          </label>
          {usePassphrase && (
            <>
              <input
                className="input"
                type="password"
                placeholder="Shared passphrase (tell your recipient out-of-band)"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
              />
              <div className="row row--wrap u-mt-8">
                <span className="pill">Passphrase strength: {passphraseStrength}</span>
                <button className="btn btn--ghost btn--sm" type="button" onClick={generatePassphrase}>
                  Generate passphrase
                </button>
              </div>
            </>
          )}

          <details className="details-panel u-mt-14">
            <summary>What can the server see?</summary>
            <p>
              Live mode uses the server only to introduce the two browsers. Send
              for later stores encrypted bytes, file metadata, expiry, and size.
              File contents, passphrases, and decryption keys stay in browsers.
            </p>
          </details>

          <details className="details-panel">
            <summary>Transfer security details</summary>
            <div className="audit-panel">
              <div className="audit-panel__row">
                <strong>Mode</strong>
                <span>{deliveryMode === "live" ? "Live peer-to-peer" : "Send for later"}</span>
              </div>
              <div className="audit-panel__row">
                <strong>Items</strong>
                <span>{mode === "files" ? files.length + (fileNote.trim() ? 1 : 0) : 1}</span>
              </div>
              <div className="audit-panel__row">
                <strong>Passphrase</strong>
                <span>{usePassphrase ? "Required" : "Link secret only"}</span>
              </div>
              <div className="audit-panel__row">
                <strong>Expiry</strong>
                <span>{deliveryMode === "store" ? "Stored copy expires automatically" : EXPIRY_OPTIONS.find((opt) => opt.seconds === expirySeconds)?.label}</span>
              </div>
            </div>
          </details>

          <button
            className="btn btn--block u-mt-18"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            🔒 Create secure invite
          </button>
        </>
      )}

      {/* Invite link + waiting state (live P2P only) */}
      {started &&
        state?.transferMode === "live" &&
        state?.inviteUrl &&
        phase !== "transferring" && (
          <>
            <InviteLink url={state.inviteUrl} expiresAt={state.expiresAt ?? null} />
            {state.fingerprint && (
              <p className="card__hint u-mt-14">
                Your safety code:{" "}
                <span className="fingerprint">{state.fingerprint}</span>
                <br />
                For maximum security, compare this with your recipient over a
                trusted channel — it should match exactly.
              </p>
            )}
            <div className="status u-mt-14" role="status" aria-live="polite">
              <span className="dot dot--live" /> {statusText}
            </div>
          </>
        )}

      {/* Transfer progress */}
      {phase === "transferring" && (
        <>
          <TransferProgressView
            progress={state?.progress ?? null}
            label="Encrypting & sending…"
          />
          <ConnectionBadge type={state?.connectionType ?? null} />
          {state?.recoveringConnection && (
            <div className="warn" role="status">
              <span>↻</span>
              <span>
                Connection health: recovering. Keep both tabs open; SecureSend
                will retry the route automatically.
              </span>
            </div>
          )}
          <button
            className="btn btn--danger btn--block u-mt-16"
            onClick={onCancel}
          >
            Cancel transfer
          </button>
        </>
      )}

      {/* Store-and-forward upload progress */}
      {phase === "uploading" && (
        <>
          <TransferProgressView
            progress={state?.progress ?? null}
            label="Encrypting & uploading…"
          />
          <p className="card__hint u-mt-8">
            Uploads can resume automatically after brief network drops. Keep this
            tab open until the share link appears.
          </p>
          <button
            className="btn btn--danger btn--block u-mt-16"
            onClick={onCancel}
          >
            Cancel upload
          </button>
        </>
      )}

      {started && state?.transferMode === "live" && phase !== "transferring" && (
        <button
          className="btn btn--ghost btn--block u-mt-18"
          onClick={onCancel}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

function senderStatus(phase: string): string {
  switch (phase) {
    case "creating-room":
      return "Creating secure room…";
    case "waiting-for-peer":
      return "Waiting for your recipient to open the link…";
    case "peer-connected":
      return "Recipient connected. Exchanging keys…";
    case "key-exchange":
      return "Performing ECDH key exchange…";
    case "connecting-webrtc":
      return "Establishing peer-to-peer connection…";
    default:
      return "Working…";
  }
}

function copyFileWithName(file: File, name: string): File {
  const nextName = name.trim() || file.name;
  return new File([file], nextName, {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  });
}

function describePassphrase(passphrase: string): string {
  if (passphrase.length >= 18) return "strong";
  if (passphrase.length >= 10) return "good";
  if (passphrase.length >= 4) return "okay";
  return "too short";
}
