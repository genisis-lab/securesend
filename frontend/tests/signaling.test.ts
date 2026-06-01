import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignalingClient } from "../src/lib/signaling";

/**
 * Minimal mock WebSocket that lets tests drive open/close/message events and
 * inspect how many times the client tried to (re)connect.
 */
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  private listeners: Record<string, ((ev: any) => void)[]> = {};

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }

  private emit(type: string, ev: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  // Test helpers --------------------------------------------------------------
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }
  simulateMessage(obj: unknown) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
  simulateDrop(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("error");
    this.emit("close", { code });
  }

  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

describe("SignalingClient auto-reconnect", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not surface a fatal error on an unexpected socket drop", () => {
    let errored = false;
    let reconnecting = false;
    const client = new SignalingClient("wss://x", "room1", {
      onError: () => {
        errored = true;
      },
      onReconnecting: () => {
        reconnecting = true;
      },
    });
    client.connect();

    const first = MockWebSocket.instances[0];
    first.simulateOpen();
    first.simulateDrop(); // network blip / tab suspended

    expect(errored).toBe(false);
    expect(reconnecting).toBe(true);
  });

  it("reconnects with backoff and fires onReconnected on success", () => {
    let reconnected = false;
    const client = new SignalingClient("wss://x", "room1", {
      onReconnected: () => {
        reconnected = true;
      },
    });
    client.connect();

    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[0].simulateDrop();

    // Advance past the first backoff delay to trigger the reconnect attempt.
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(2);

    MockWebSocket.instances[1].simulateOpen();
    expect(reconnected).toBe(true);
  });

  it("does NOT reconnect after a deliberate room-full close (4001)", () => {
    let roomFull = false;
    const client = new SignalingClient("wss://x", "room1", {
      onRoomFull: () => {
        roomFull = true;
      },
    });
    client.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ kind: "room-full" });
    ws.simulateDrop(4001);

    vi.advanceTimersByTime(10000);
    expect(roomFull).toBe(true);
    // No new socket should have been created.
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("stops reconnecting after close() is called", () => {
    const client = new SignalingClient("wss://x", "room1", {});
    client.connect();
    MockWebSocket.instances[0].simulateOpen();

    client.close();
    MockWebSocket.instances[0].simulateDrop();

    vi.advanceTimersByTime(10000);
    expect(MockWebSocket.instances.length).toBe(1);
  });
});
