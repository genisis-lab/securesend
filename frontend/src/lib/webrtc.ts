/**
 * webrtc.ts — WebRTC connection manager.
 *
 * Wraps RTCPeerConnection + a single reliable, ordered DataChannel used to
 * carry encrypted file frames peer-to-peer. The signaling client is injected
 * so this manager only handles the WebRTC side (offer/answer/ICE) plus the
 * ECDH public-key exchange that piggybacks on the same signaling channel.
 *
 * Roles:
 *   - initiator (sender): creates the DataChannel and the SDP offer.
 *   - responder (receiver): answers and receives the DataChannel via ondatachannel.
 *
 * The DataChannel only ever carries ALREADY-ENCRYPTED bytes (see chunker.ts /
 * transfer.ts). WebRTC also encrypts the transport (DTLS-SRTP), so file data
 * is double-protected: app-layer AES-GCM + transport DTLS.
 */

import { PeerRole, SignalData, SignalingClient } from "./signaling";

export interface WebRtcEvents {
  onChannelOpen?: () => void;
  onChannelClose?: () => void;
  /** Raw DataChannel payload: string for control messages, ArrayBuffer for frames. */
  onMessage?: (data: ArrayBuffer | string) => void;
  /** Fired when we receive the peer's raw public ECDH key + salt. */
  onPeerPublicKey?: (rawPublicKey: Uint8Array, salt: Uint8Array) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  /** Fired when an automatic ICE restart is attempted to recover a drop. */
  onIceRestart?: () => void;
  /** Fired once the active path is known: "direct" (P2P) or "relay" (via TURN). */
  onConnectionType?: (type: ConnectionType) => void;
  onError?: (err: string) => void;
}

/** How the peers are actually connected once ICE settles. */
export type ConnectionType = "direct" | "relay" | "unknown";

interface PublicKeyPayload {
  /** base64 raw public key */
  key: string;
  /** base64 HKDF salt */
  salt: string;
}

export class WebRtcManager {
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private role: PeerRole;
  private signaling: SignalingClient;
  private events: WebRtcEvents;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;
  /** How many automatic ICE restarts we've attempted (initiator only). */
  private iceRestartAttempts = 0;
  private static readonly MAX_ICE_RESTARTS = 2;
  private closed = false;

  constructor(
    role: PeerRole,
    signaling: SignalingClient,
    iceServers: RTCIceServer[],
    events: WebRtcEvents,
  ) {
    this.role = role;
    this.signaling = signaling;
    this.events = events;

    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        this.signaling.send({
          type: "ice-candidate",
          payload: ev.candidate.toJSON(),
        });
      }
    });

    this.pc.addEventListener("connectionstatechange", () => {
      this.events.onConnectionStateChange?.(this.pc.connectionState);
      // Once connected, inspect the selected ICE candidate pair to learn
      // whether we're going direct (P2P) or relaying through TURN.
      if (this.pc.connectionState === "connected") {
        void this.detectConnectionType();
      }
    });

    // Recover transient ICE failures (network change, Wi-Fi↔cellular) with an
    // ICE restart before giving up. Only the initiator re-offers; the responder
    // answers the renegotiation.
    this.pc.addEventListener("iceconnectionstatechange", () => {
      const st = this.pc.iceConnectionState;
      if ((st === "failed" || st === "disconnected") && !this.closed) {
        void this.maybeRestartIce();
      }
    });

    // Responder receives the DataChannel created by the initiator.
    this.pc.addEventListener("datachannel", (ev) => {
      this.channel = ev.channel;
      this.wireChannel();
    });
  }

  /**
   * Begin the WebRTC handshake. The initiator creates the channel and offer;
   * the responder simply waits for the offer to arrive via signaling.
   */
  async start(): Promise<void> {
    if (this.role === "initiator") {
      this.channel = this.pc.createDataChannel("securesend", {
        ordered: true,
      });
      this.channel.binaryType = "arraybuffer";
      this.wireChannel();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.send({ type: "offer", payload: offer });
    }
  }

  /** Send our public ECDH key + salt to the peer through signaling. */
  sendPublicKey(rawPublicKey: Uint8Array, salt: Uint8Array): void {
    const payload: PublicKeyPayload = {
      key: bytesToBase64(rawPublicKey),
      salt: bytesToBase64(salt),
    };
    this.signaling.send({ type: "ecdh-public-key", payload });
  }

  /**
   * Inspect getStats() to determine whether the active connection is direct
   * (host/srflx candidates) or relayed through a TURN server (relay candidate).
   * If either end of the selected/nominated candidate pair is a relay, the
   * traffic is going through TURN.
   */
  private async detectConnectionType(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      const candidates = new Map<string, RTCIceCandidatePairStats | any>();
      let selectedPair: any = null;

      stats.forEach((report: any) => {
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          candidates.set(report.id, report);
        }
      });
      // Find the active pair: prefer the transport's selectedCandidatePairId,
      // else a succeeded+nominated candidate-pair.
      stats.forEach((report: any) => {
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const pair = (stats as any).get?.(report.selectedCandidatePairId);
          if (pair) selectedPair = pair;
        }
      });
      if (!selectedPair) {
        stats.forEach((report: any) => {
          if (
            report.type === "candidate-pair" &&
            (report.selected || (report.state === "succeeded" && report.nominated))
          ) {
            selectedPair = report;
          }
        });
      }

      if (!selectedPair) {
        this.events.onConnectionType?.("unknown");
        return;
      }

      const local = candidates.get(selectedPair.localCandidateId);
      const remote = candidates.get(selectedPair.remoteCandidateId);
      const isRelay =
        local?.candidateType === "relay" || remote?.candidateType === "relay";
      this.events.onConnectionType?.(isRelay ? "relay" : "direct");
    } catch {
      this.events.onConnectionType?.("unknown");
    }
  }

  /**
   * Attempt to recover a failed/dropped ICE connection by renegotiating with
   * fresh ICE candidates. Only the initiator drives the restart (creates a new
   * offer with iceRestart:true); the responder answers normally. Bounded so we
   * don't loop forever on a genuinely dead network.
   */
  private async maybeRestartIce(): Promise<void> {
    if (this.closed) return;
    if (this.role !== "initiator") return; // responder answers the re-offer
    if (this.iceRestartAttempts >= WebRtcManager.MAX_ICE_RESTARTS) return;

    // Give "disconnected" a moment to self-heal before forcing a restart.
    await new Promise((r) => setTimeout(r, 1500));
    const st = this.pc.iceConnectionState;
    if (this.closed || (st !== "failed" && st !== "disconnected")) return;

    this.iceRestartAttempts += 1;
    this.events.onIceRestart?.();
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.signaling.send({ type: "offer", payload: offer });
    } catch {
      /* if this throws, connectionstatechange=failed will surface the error */
    }
  }

  /** Handle an inbound signal relayed from the peer. */
  async handleSignal(data: SignalData): Promise<void> {
    try {
      switch (data.type) {
        case "ecdh-public-key": {
          const p = data.payload as PublicKeyPayload;
          this.events.onPeerPublicKey?.(
            base64ToBytes(p.key),
            base64ToBytes(p.salt),
          );
          break;
        }
        case "offer": {
          await this.pc.setRemoteDescription(
            data.payload as RTCSessionDescriptionInit,
          );
          this.remoteDescSet = true;
          await this.drainCandidates();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.signaling.send({ type: "answer", payload: answer });
          break;
        }
        case "answer": {
          await this.pc.setRemoteDescription(
            data.payload as RTCSessionDescriptionInit,
          );
          this.remoteDescSet = true;
          await this.drainCandidates();
          break;
        }
        case "ice-candidate": {
          const candidate = data.payload as RTCIceCandidateInit;
          if (this.remoteDescSet) {
            await this.pc.addIceCandidate(candidate);
          } else {
            // Buffer candidates that arrive before the remote description.
            this.pendingCandidates.push(candidate);
          }
          break;
        }
        case "ready":
          break;
      }
    } catch (err) {
      this.events.onError?.(
        err instanceof Error ? err.message : "webrtc-signal-error",
      );
    }
  }

  private async drainCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* ignore individual candidate errors */
      }
    }
  }

  private wireChannel(): void {
    if (!this.channel) return;
    this.channel.binaryType = "arraybuffer";
    this.channel.addEventListener("open", () => this.events.onChannelOpen?.());
    this.channel.addEventListener("close", () => this.events.onChannelClose?.());
    this.channel.addEventListener("message", (ev) => {
      // Strings carry JSON control messages; ArrayBuffers carry encrypted
      // frames. Pass the native type through so the session can route it.
      this.events.onMessage?.(ev.data as ArrayBuffer | string);
    });
    this.channel.addEventListener("error", () =>
      this.events.onError?.("datachannel-error"),
    );
  }

  get dataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  setBufferedAmountLowThreshold(bytes: number): void {
    if (this.channel) this.channel.bufferedAmountLowThreshold = bytes;
  }

  /** Send raw bytes over the DataChannel (already encrypted by caller). */
  sendBytes(data: Uint8Array | ArrayBuffer): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(data as ArrayBuffer);
    }
  }

  /** Send a small JSON control message over the DataChannel. */
  sendControl(obj: unknown): void {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify(obj));
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
  }
}

// Local base64 helpers (avoid importing crypto.ts here to keep modules lean).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
