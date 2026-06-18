/**
 * signaling.ts — thin WebSocket client for the Cloudflare signaling Worker.
 *
 * The signaling channel is used ONLY to:
 *   - learn our role (initiator/responder),
 *   - learn when the peer joins/leaves,
 *   - relay WebRTC SDP + ICE candidates,
 *   - relay each peer's *public* ECDH key + salt.
 *
 * No private keys, derived secrets, or file bytes ever cross this channel.
 */

export type PeerRole = "initiator" | "responder";

export type SignalDataType =
  | "ecdh-public-key"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "ready";

export interface SignalData {
  type: SignalDataType;
  payload: unknown;
}

export interface SignalEnvelope {
  kind:
    | "welcome"
    | "peer-joined"
    | "peer-left"
    | "room-full"
    | "room-expired"
    | "error"
    | "signal";
  role?: PeerRole;
  peerPresent?: boolean;
  expiresAt?: number;
  data?: SignalData;
  reason?: string;
}

export interface SignalingEvents {
  onWelcome?: (role: PeerRole, peerPresent: boolean, expiresAt?: number) => void;
  onPeerJoined?: () => void;
  onPeerLeft?: () => void;
  onRoomFull?: () => void;
  onRoomExpired?: () => void;
  onSignal?: (data: SignalData) => void;
  onError?: (reason: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Fired when the socket dropped and we are attempting to reconnect. */
  onReconnecting?: () => void;
  /** Fired when a reconnect attempt re-establishes the socket. */
  onReconnected?: () => void;
}

/**
 * WebSocket client for the signaling Worker with automatic reconnection.
 *
 * Mobile browsers suspend backgrounded tabs and tear down their WebSockets —
 * which is exactly what happens when the sender switches apps to share the
 * invite link. Rather than treating that drop as a fatal error, we transparently
 * reconnect (with backoff, and immediately when the tab returns to the
 * foreground). The server holds each peer's role slot for a short grace window,
 * so a quick reconnect reclaims the same role. A fatal error is only surfaced
 * after we exhaust reconnection attempts or the server deliberately ends the
 * room (room-full / room-expired).
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private events: SignalingEvents;

  /** We initiated the close (teardown); do not reconnect. */
  private closedByUs = false;
  /** Server ended the room (full/expired); do not reconnect. */
  private terminal = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedOnce = false;
  private readonly maxReconnectAttempts = 12;
  private readonly baseDelayMs = 500;
  private readonly maxDelayMs = 8000;

  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  constructor(
    signalBaseUrl: string,
    roomId: string,
    events: SignalingEvents,
    ttlSeconds?: number,
  ) {
    // signalBaseUrl like ws://localhost:8787 or wss://...workers.dev
    const base = signalBaseUrl.replace(/\/+$/, "");
    const query =
      typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
        ? `?ttl=${Math.floor(ttlSeconds)}`
        : "";
    this.url = `${base}/api/rooms/${encodeURIComponent(roomId)}/ws${query}`;
    this.events = events;
  }

  connect(): void {
    this.installRecoveryListeners();
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUs || this.terminal) return;
    // Clean up any half-open prior socket.
    this.teardownSocket();

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      const wasReconnecting = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      this.reconnectAttempts = 0;
      if (wasReconnecting) {
        this.events.onReconnected?.();
      } else {
        this.events.onOpen?.();
      }
    });

    ws.addEventListener("message", (ev) => {
      let env: SignalEnvelope;
      try {
        env = JSON.parse(
          typeof ev.data === "string"
            ? ev.data
            : new TextDecoder().decode(ev.data as ArrayBuffer),
        );
      } catch {
        return;
      }
      this.dispatch(env);
    });

    ws.addEventListener("close", (ev) => {
      if (this.closedByUs || this.terminal) return;
      // 4001 = room-full, 4002 = room-expired: deliberate server closes that
      // must not be retried (the matching message already drove the UI).
      if (ev.code === 4001 || ev.code === 4002) {
        this.terminal = true;
        return;
      }
      this.scheduleReconnect();
    });

    // A socket "error" is always followed by a "close"; let close drive the
    // reconnect logic. We deliberately do NOT surface this as a fatal error.
    ws.addEventListener("error", () => {
      /* handled via close */
    });
  }

  /** Schedule a reconnect attempt with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.closedByUs || this.terminal) return;
    if (this.reconnectTimer) return; // already scheduled

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Give up only after sustained failure (rare while foregrounded).
      this.events.onClose?.();
      return;
    }

    this.events.onReconnecting?.();

    const delay = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  /** Reconnect immediately (used when the tab returns or network is back). */
  private reconnectNow(): void {
    if (this.closedByUs || this.terminal) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reset backoff so a foreground return retries promptly.
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  /**
   * Reconnect proactively when the tab becomes visible again or the device
   * regains connectivity. On mobile this is the primary recovery path, since
   * backgrounded pages are frozen and their reconnect timers don't fire until
   * the user returns to the app.
   */
  private installRecoveryListeners(): void {
    if (typeof document !== "undefined" && !this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.visibilityState === "visible") this.reconnectNow();
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    if (typeof window !== "undefined" && !this.onlineHandler) {
      this.onlineHandler = () => this.reconnectNow();
      window.addEventListener("online", this.onlineHandler);
    }
  }

  private removeRecoveryListeners(): void {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    try {
      // Detach our handlers and close without triggering reconnect logic.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private dispatch(env: SignalEnvelope): void {
    switch (env.kind) {
      case "welcome":
        this.events.onWelcome?.(
          env.role ?? "responder",
          env.peerPresent ?? false,
          env.expiresAt,
        );
        break;
      case "peer-joined":
        this.events.onPeerJoined?.();
        break;
      case "peer-left":
        this.events.onPeerLeft?.();
        break;
      case "room-full":
        this.terminal = true;
        this.events.onRoomFull?.();
        break;
      case "room-expired":
        this.terminal = true;
        this.events.onRoomExpired?.();
        break;
      case "signal":
        if (env.data) this.events.onSignal?.(env.data);
        break;
      case "error":
        this.events.onError?.(env.reason ?? "unknown-error");
        break;
    }
  }

  /** Relay a signal payload to the other peer through the server. */
  send(data: SignalData): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const env: SignalEnvelope = { kind: "signal", data };
      this.ws.send(JSON.stringify(env));
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.removeRecoveryListeners();
    this.teardownSocket();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/** Create a new signaling room via the Worker HTTP endpoint. */
export async function createRoom(signalBaseUrl: string): Promise<string> {
  // Convert ws(s):// base to http(s):// for the REST call.
  const httpBase = signalBaseUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${httpBase}/api/rooms`, { method: "POST" });
  } catch {
    // Browsers surface network failures as cryptic TypeErrors (Safari:
    // "Load failed", Chrome: "Failed to fetch"); translate into something
    // the user can act on.
    throw new Error(
      "Can't reach the SecureSend server. Check your internet connection and try again.",
    );
  }
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error(
        "Too many new transfers right now — wait a moment and try again.",
      );
    }
    throw new Error(`Failed to create signaling room (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { roomId: string };
  return json.roomId;
}
