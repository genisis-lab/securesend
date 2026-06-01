import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TransferSession,
  buildInviteUrl,
  buildStoreInviteUrl,
  parseInviteFromHash,
} from "../src/lib/session";

/**
 * Session state-machine tests. The session orchestrates signaling + WebRTC +
 * transfer; here we mock the network primitives (WebSocket, RTCPeerConnection,
 * fetch) and assert the OBSERVABLE state transitions — the area where the
 * reconnect / peer-left / cancel bugs lived.
 */

// --- Mocks ------------------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static last: FakeWebSocket | null = null;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  private listeners: Record<string, ((ev: any) => void)[]> = {};

  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  addEventListener(t: string, fn: (ev: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  emit(t: string, ev: any = {}) {
    for (const fn of this.listeners[t] ?? []) fn(ev);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }
  message(obj: unknown) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
}

class FakeRTCPeerConnection {
  iceConnectionState = "new";
  connectionState = "new";
  localDescription: any = null;
  private listeners: Record<string, ((ev: any) => void)[]> = {};
  constructor() {}
  addEventListener(t: string, fn: (ev: any) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  createDataChannel() {
    return makeFakeChannel();
  }
  async createOffer() {
    return { type: "offer", sdp: "x" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "x" };
  }
  async setLocalDescription(d: any) {
    this.localDescription = d;
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return new Map();
  }
  close() {}
}

function makeFakeChannel() {
  const listeners: Record<string, ((ev: any) => void)[]> = {};
  return {
    binaryType: "arraybuffer",
    readyState: "open",
    bufferedAmount: 0,
    addEventListener: (t: string, fn: (ev: any) => void) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: () => {},
    send: () => {},
    close: () => {},
    _emit: (t: string, ev: any = {}) => {
      for (const fn of listeners[t] ?? []) fn(ev);
    },
  };
}

describe("invite link helpers", () => {
  it("builds and parses a live link with room id + link secret", () => {
    const url = buildInviteUrl("room123", "secretABC", false);
    const hash = url.slice(url.indexOf("#"));
    const parsed = parseInviteFromHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("live");
    expect(parsed!.roomId).toBe("room123");
    expect(parsed!.linkSecret).toBe("secretABC");
    expect(parsed!.requiresPassphrase).toBe(false);
  });

  it("builds and parses a store-and-forward link", () => {
    const url = buildStoreInviteUrl("store789", "secretXYZ", true);
    const parsed = parseInviteFromHash(url.slice(url.indexOf("#")));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("store");
    expect(parsed!.roomId).toBe("store789");
    expect(parsed!.linkSecret).toBe("secretXYZ");
    expect(parsed!.requiresPassphrase).toBe(true);
  });

  it("encodes the passphrase-required flag", () => {
    const url = buildInviteUrl("r", "k", true);
    const parsed = parseInviteFromHash(url.slice(url.indexOf("#")));
    expect(parsed!.requiresPassphrase).toBe(true);
  });

  it("returns null for non-invite hashes", () => {
    expect(parseInviteFromHash("#/about")).toBeNull();
    expect(parseInviteFromHash("")).toBeNull();
  });
});

describe("TransferSession state machine", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket as any);
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection as any);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/rooms")) {
          return { ok: true, json: async () => ({ roomId: "room-abc-123456" }) } as any;
        }
        if (String(url).includes("/api/ice")) {
          return { ok: true, json: async () => ({ iceServers: [] }) } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sender: creates a room and reaches waiting-for-peer with an invite link", async () => {
    const session = new TransferSession();
    const states: string[] = [];
    session.subscribe((s) => states.push(s.phase));

    const file = new File([new Uint8Array([1, 2, 3])], "hello.txt", {
      type: "text/plain",
    });
    await session.startSend([file], undefined, 600);

    const snap = session.snapshot;
    expect(snap.role).toBe("initiator");
    expect(snap.roomId).toBe("room-abc-123456");
    expect(snap.inviteUrl).toContain("#/r/room-abc-123456/k/");
    expect(snap.phase).toBe("waiting-for-peer");
    expect(snap.itemCount).toBe(1);
    expect(states).toContain("creating-room");
    session.destroy();
  });

  it("sender: a pre-transfer peer-left returns to waiting (not fatal)", async () => {
    // Models a link-preview crawler grabbing the slot then leaving.
    const session = new TransferSession();
    const file = new File([new Uint8Array([1])], "a.bin");
    await session.startSend([file]);

    // Drive a peer-joined then peer-left via the signaling socket.
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.message({ kind: "welcome", role: "initiator", peerPresent: false, expiresAt: Date.now() + 60000 });
    ws.message({ kind: "peer-joined" });
    // handshake starts; now the visitor leaves before transferring.
    ws.message({ kind: "peer-left" });

    // Allow async setupWebRtc (ICE fetch) microtasks to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(["waiting-for-peer", "peer-connected", "key-exchange"]).toContain(
      session.snapshot.phase,
    );
    expect(session.snapshot.phase).not.toBe("error");
    session.destroy();
  });

  it("sender: cancel() moves to the cancelled phase", async () => {
    const session = new TransferSession();
    const file = new File([new Uint8Array([1])], "a.bin");
    await session.startSend([file]);
    session.cancel();
    expect(session.snapshot.phase).toBe("cancelled");
    session.destroy();
  });

  it("receiver: room-full surfaces a clear error", async () => {
    const session = new TransferSession();
    await session.startReceive("room-xyz-7890ab", "k");
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.message({ kind: "room-full" });
    expect(session.snapshot.phase).toBe("error");
    expect(session.snapshot.error).toMatch(/full/i);
    session.destroy();
  });

  it("receiver: room-expired moves to the expired phase", async () => {
    const session = new TransferSession();
    await session.startReceive("room-xyz-7890ab", "k");
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.message({ kind: "room-expired" });
    expect(session.snapshot.phase).toBe("expired");
    session.destroy();
  });

  it("receiver arriving FIRST (sender left & rejoins) still progresses, no role stall", async () => {
    // Regression: previously the session tied transfer direction to the
    // server's connection-order slot. If the receiver connected before the
    // sender, the sender's role inverted and the handshake stalled. Direction
    // is now fixed at start, so the receiver must proceed past waiting even
    // when the server reports it as the FIRST/initiator slot.
    const session = new TransferSession();
    await session.startReceive("room-recv-first12", "k");
    const ws = FakeWebSocket.last!;
    ws.open();
    // Server assigns this early-arriving receiver the "initiator" slot, peer
    // not present yet. The session must IGNORE that slot for direction.
    ws.message({ kind: "welcome", role: "initiator", peerPresent: false, expiresAt: Date.now() + 60000 });
    // Sender now joins.
    ws.message({ kind: "peer-joined" });
    await Promise.resolve();
    await Promise.resolve();

    // It must have left "waiting" and begun the handshake as a receiver — not
    // errored, not stuck pre-handshake.
    const p = session.snapshot.phase;
    expect(p).not.toBe("error");
    expect(["peer-connected", "key-exchange", "connecting-webrtc", "transferring"]).toContain(p);
    session.destroy();
  });
});
