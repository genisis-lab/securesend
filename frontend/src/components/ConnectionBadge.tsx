import { ConnectionType } from "../lib/webrtc";

interface Props {
  type: ConnectionType | null;
}

/**
 * Shows how the two peers are connected once ICE settles:
 *   - direct: a true peer-to-peer link (no relay).
 *   - relay : traffic is relayed through a TURN server (still encrypted
 *             end-to-end; TURN only sees ciphertext). Used when a direct path
 *             can't be established (e.g. strict/cellular NAT).
 */
export function ConnectionBadge({ type }: Props) {
  if (!type || type === "unknown") return null;

  if (type === "relay") {
    return (
      <div className="conn-badge conn-badge--relay" title="Relayed via TURN — still end-to-end encrypted">
        <span aria-hidden>🔁</span>
        <span>
          Relayed connection (via TURN). Still end-to-end encrypted — the relay
          only sees scrambled data.
        </span>
      </div>
    );
  }

  return (
    <div className="conn-badge conn-badge--direct" title="Direct peer-to-peer connection">
      <span aria-hidden>⚡</span>
      <span>Direct peer-to-peer connection</span>
    </div>
  );
}
