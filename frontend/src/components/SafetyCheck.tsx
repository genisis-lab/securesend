interface Props {
  /** The short authentication string (SAS) to compare with the peer. */
  code: string | null;
  /** Label for the confirm button, e.g. "Codes match \u2014 send". */
  confirmLabel: string;
  /** Who to compare with, e.g. "your recipient" or "the sender". */
  peerLabel: string;
  onConfirm: () => void;
  onReject: () => void;
}

/**
 * Short Authentication String (SAS) confirmation gate.
 *
 * Both peers derive the SAME code from BOTH public keys, so a machine-in-the
 * -middle (which negotiates a separate key with each side) makes the two
 * screens show DIFFERENT codes. The transfer is held until the local user
 * confirms the codes match, so plaintext never reaches an interceptor.
 */
export function SafetyCheck({
  code,
  confirmLabel,
  peerLabel,
  onConfirm,
  onReject,
}: Props) {
  return (
    <div className="card">
      <div className="success-icon">\u{1F510}</div>
      <h2 className="card__title u-center">Check the safety code</h2>
      <p className="card__hint u-center">
        Compare this code with {peerLabel} over a trusted channel \u2014 read it
        aloud on a call, for example. It must match <strong>exactly</strong> on
        both screens. Matching codes prove no one is intercepting your
        connection.
      </p>
      <p className="u-center u-mt-14">
        <span className="fingerprint">{code ?? "unavailable"}</span>
      </p>
      <button
        className="btn btn--block u-mt-16"
        onClick={onConfirm}
        disabled={!code}
      >
        \u2713 {confirmLabel}
      </button>
      <button
        className="btn btn--ghost btn--block u-mt-10"
        onClick={onReject}
      >
        They don't match \u2014 stop
      </button>
    </div>
  );
}
