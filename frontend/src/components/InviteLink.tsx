import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { INVITE_TTL_SECONDS } from "../lib/config";

interface Props {
  url: string;
  /** Absolute epoch-ms expiry from the server, or null until known. */
  expiresAt: number | null;
}

/** Shows the invite link with copy button, QR code, and a live expiry countdown. */
export function InviteLink({ url, expiresAt }: Props) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() => computeRemaining(expiresAt));

  useEffect(() => {
    const tick = () => setRemaining(computeRemaining(expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // Render the QR lazily the first time it's shown.
  useEffect(() => {
    if (showQr && !qrDataUrl) {
      QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240,
        color: { dark: "#0b1020", light: "#ffffff" },
      })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(null));
    }
  }, [showQr, qrDataUrl, url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be blocked; fall back to selecting the text.
      setCopied(false);
    }
  };

  const expired = remaining <= 0;
  const countdown = formatCountdown(remaining);

  return (
    <div>
      <label className="label">Secure invite link</label>
      <div className="invite-box">
        <input className="input" readOnly value={url} aria-label="Invite link" />
        <button className="btn" onClick={copy} disabled={expired}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <button
        className="btn btn--ghost btn--block u-mt-10"
        onClick={() => setShowQr((v) => !v)}
        disabled={expired}
      >
        {showQr ? "Hide QR code" : "📱 Show QR code"}
      </button>

      {showQr && !expired && (
        <div className="qr">
          {qrDataUrl ? (
            <img className="qr__img" src={qrDataUrl} alt="Invite link QR code" />
          ) : (
            <div className="qr__loading">Generating QR…</div>
          )}
          <p className="card__hint u-center u-mt-8">
            Scan with the recipient's camera to open the transfer.
          </p>
        </div>
      )}

      <p className="card__hint u-mt-10">
        {expired ? (
          <span className="error-text">This invite has expired. Create a new one.</span>
        ) : (
          <>
            Expires in <span className="timer">{countdown}</span>
          </>
        )}
      </p>

      <div className="warn">
        <span>⚠️</span>
        <span>
          This link contains the secret key needed to decrypt the file. Anyone who
          opens it before it expires can receive the transfer. Share it only with your
          intended recipient over a trusted channel. For extra safety, add a passphrase
          below.
        </span>
      </div>
    </div>
  );
}

/**
 * Seconds remaining until the absolute expiry time. While the server's
 * `expiresAt` is still unknown (null), fall back to the configured default
 * TTL so the countdown shows a sensible placeholder.
 */
function computeRemaining(expiresAt: number | null): number {
  if (!expiresAt || expiresAt <= 0) return INVITE_TTL_SECONDS;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

/** Format remaining seconds as H:MM:SS or M:SS depending on magnitude. */
function formatCountdown(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
