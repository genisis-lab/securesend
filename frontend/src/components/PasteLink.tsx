import { useState } from "react";
import { parseInviteFromHash } from "../lib/session";

interface Props {
  /** Navigate to a received-invite route once a valid link is parsed. */
  onOpen: (hash: string) => void;
}

/**
 * Lets a recipient paste an invite link (or just its #fragment) and open it
 * without leaving the app. Useful when the link arrives somewhere that doesn't
 * make it tappable, or when the recipient is already on the site.
 */
export function PasteLink({ onOpen }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    const hash = extractHash(value.trim());
    const invite = hash ? parseInviteFromHash(hash) : null;
    if (!hash || !invite) {
      setError("That doesn't look like a valid SecureSend invite link.");
      return;
    }
    if (!invite.linkSecret) {
      setError(
        "This invite is missing its secret key. Ask the sender to copy the full link again.",
      );
      return;
    }
    setError(null);
    onOpen(hash);
  };

  return (
    <div className="card">
      <h2 className="card__title">Have an invite link?</h2>
      <p className="card__hint">
        Paste a SecureSend link below to connect to the sender and download
        their file. The transfer is end-to-end encrypted and peer-to-peer.
      </p>
      <div className="invite-box">
        <input
          className="input"
          type="text"
          inputMode="url"
          placeholder="https://your-app.pages.dev/#/r/…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") open();
          }}
          aria-label="Invite link"
        />
        <button className="btn" onClick={open} disabled={value.trim().length === 0}>
          Open
        </button>
      </div>
      {error && <p className="error-text u-mt-8">{error}</p>}
    </div>
  );
}

/**
 * Extract the `#/r/…` fragment from a full URL, a bare fragment, or a path.
 * Returns null if no usable fragment is present.
 */
function extractHash(input: string): string | null {
  if (!input) return null;
  // Full URL: take everything from the first '#'.
  const hashIndex = input.indexOf("#");
  if (hashIndex >= 0) {
    return input.slice(hashIndex);
  }
  // Bare fragment without the leading '#'.
  if (input.startsWith("/r/")) return `#${input}`;
  if (input.startsWith("r/")) return `#/${input}`;
  return null;
}
