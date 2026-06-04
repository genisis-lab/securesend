/**
 * Signaling protocol shared message shapes.
 *
 * IMPORTANT SECURITY NOTE:
 * The signaling server is a "dumb pipe". It relays opaque JSON messages
 * between two peers. It never inspects, validates, or stores the payloads of
 * WebRTC SDP, ICE candidates, or the peers' *public* ECDH keys. It has no
 * knowledge of the derived AES key, the file, or any private key material.
 *
 * The only message types the server understands structurally are the control
 * messages it must act on (join lifecycle). Everything else is relayed
 * verbatim to the other peer.
 */

/** Control + relay message kinds understood at the signaling layer. */
export type SignalKind =
  // --- Server -> client control messages ---
  | "welcome" // sent to a peer right after it joins; tells it its role
  | "peer-joined" // the other peer connected
  | "peer-left" // the other peer disconnected (may reconnect within grace)
  | "room-full" // a third peer tried to join; it is rejected
  | "room-expired" // the room TTL elapsed
  | "error" // generic error with a human-readable reason
  // --- Relayed peer <-> peer messages (server does not interpret `data`) ---
  | "signal"; // carries SDP / ICE / public-key handshake data

/** Role assigned by the server. The first peer is the initiator (sender). */
export type PeerRole = "initiator" | "responder";

/** Sub-types carried inside a relayed `signal` message's `data` field. */
export type SignalDataType =
  | "ecdh-public-key" // base64 raw public ECDH key
  | "offer" // RTCSessionDescription (WebRTC offer)
  | "answer" // RTCSessionDescription (WebRTC answer)
  | "ice-candidate" // RTCIceCandidateInit
  | "ready"; // peer signals it is ready to start the handshake

export interface SignalEnvelope {
  kind: SignalKind;
  /** Present on `welcome`: the role assigned to the receiving peer. */
  role?: PeerRole;
  /** Present on `welcome`: whether the other peer is already present. */
  peerPresent?: boolean;
  /** Present on `welcome`: absolute epoch-ms time the room expires. */
  expiresAt?: number;
  /** Present on relayed `signal` messages. Opaque to the server. */
  data?: {
    type: SignalDataType;
    payload: unknown;
  };
  /** Present on `error` / lifecycle messages. */
  reason?: string;
}

export function makeError(reason: string): string {
  return JSON.stringify({ kind: "error", reason } satisfies SignalEnvelope);
}

/** The opposite peer role. Pure helper, shared + unit-tested. */
export function otherRole(role: PeerRole): PeerRole {
  return role === "initiator" ? "responder" : "initiator";
}

/**
 * Clamp a client-requested room TTL (seconds) into [min, max], falling back to
 * `fallback` when the request is absent or not a finite number. Pure so the
 * room's TTL policy can be unit-tested without a Durable Object.
 */
export function clampTtl(
  requested: number | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (requested === null || !Number.isFinite(requested)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(requested)));
}
