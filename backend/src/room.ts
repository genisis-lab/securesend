/**
 * SignalingRoom Durable Object.
 *
 * One instance == one ephemeral transfer room. It coordinates exactly two
 * peers and relays opaque handshake messages between them.
 *
 * Lifecycle / security rules implemented here:
 *   - Max 2 peers. A third connection is told `room-full` and closed.
 *   - The first peer becomes the `initiator` (sender), the second the
 *     `responder` (receiver).
 *   - Relays SDP, ICE, and *public* ECDH keys verbatim. Never inspects or
 *     stores `data` payloads.
 *   - Room auto-expires after ROOM_TTL_SECONDS (invite code lifetime) using a
 *     DO alarm. Expired rooms close all sockets and clear state.
 *   - Expired room ids are TOMBSTONED for 24h so a late connect cannot revive
 *     an expired invite link with a fresh TTL.
 *   - If a peer disconnects, the other is told `peer-left`. The slot is held
 *     for RECONNECT_GRACE_SECONDS so a refreshing peer can rejoin its role.
 *   - No file bytes ever pass through here; the WebRTC DataChannel is P2P.
 */

import { Env } from "./index";
import { clampTtl, makeError, otherRole, PeerRole, SignalEnvelope } from "./protocol";

interface PeerSlot {
  socket: WebSocket;
  role: PeerRole;
  /** A per-connection token so a reconnect can reclaim the same role/slot. */
  sessionToken: string;
}

export class SignalingRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  /** Up to two active peers, keyed by role. */
  private peers = new Map<PeerRole, PeerSlot>();

  /**
   * When a peer drops, we remember which role is "reserved" for a short
   * grace window so a page refresh can reclaim it before the slot frees up.
   */
  private reservedRoles = new Map<PeerRole, number>(); // role -> expiry ms

  /** Whether the TTL alarm (room expiry) has been scheduled. */
  private ttlScheduled = false;

  /** Absolute epoch-ms time at which this room expires (set on first connect). */
  private expiresAt = 0;

  /**
   * True once the room's TTL has elapsed. Persisted as a tombstone in storage
   * so it survives DO eviction. While set, ALL connection attempts are refused
   * — otherwise a connect arriving after the expiry alarm (which wipes
   * storage) would re-arm a brand-new TTL on the same room id, resurrecting an
   * expired invite link.
   */
  private expired = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore expiry state if the DO was evicted and revived mid-room. The
    // in-memory peer sockets cannot survive eviction, but the TTL must.
    this.state.blockConcurrencyWhile(async () => {
      const tombstoned = await this.state.storage.get<boolean>("expired");
      if (tombstoned) {
        this.expired = true;
        this.ttlScheduled = true; // never re-arm a TTL for a dead room
        return;
      }
      const saved = await this.state.storage.get<number>("expiresAt");
      if (typeof saved === "number" && saved > 0) {
        this.expiresAt = saved;
        this.ttlScheduled = true;
      }
    });
  }

  private ttlSeconds(): number {
    const n = parseInt(this.env.ROOM_TTL_SECONDS ?? "600", 10);
    return Number.isFinite(n) && n > 0 ? n : 600;
  }

  /** Hard bounds for a client-requested room TTL (defense against abuse). */
  private static readonly MIN_TTL_SECONDS = 60; // 1 minute
  private static readonly MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours

  /**
   * How long an expired room id keeps refusing connections before its
   * tombstone is swept and storage returns to fully empty. Any realistic
   * "stale link clicked late" window is far shorter than this.
   */
  private static readonly TOMBSTONE_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Resolve the effective room TTL. The initiator MAY request a custom TTL via
   * the `?ttl=<seconds>` query param; we clamp it to [MIN, MAX]. If absent or
   * invalid, fall back to the configured default.
   */
  private resolveTtlSeconds(requested: number | null): number {
    return clampTtl(
      requested,
      this.ttlSeconds(),
      SignalingRoom.MIN_TTL_SECONDS,
      SignalingRoom.MAX_TTL_SECONDS,
    );
  }

  private graceSeconds(): number {
    const n = parseInt(this.env.RECONNECT_GRACE_SECONDS ?? "15", 10);
    return Number.isFinite(n) && n >= 0 ? n : 15;
  }

  async fetch(request: Request): Promise<Response> {
    // The initiator may request a custom expiry via ?ttl=<seconds>.
    const url = new URL(request.url);
    const ttlParam = url.searchParams.get("ttl");
    const requestedTtl = ttlParam !== null ? parseInt(ttlParam, 10) : null;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    await this.accept(server, requestedTtl);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Decide the role for an incoming connection and wire up handlers. */
  private async accept(
    socket: WebSocket,
    requestedTtl: number | null,
  ): Promise<void> {
    socket.accept();

    // Refuse connections to rooms that have already expired — either tombstoned
    // by the alarm, or past their deadline while the alarm hasn't fired yet.
    // Without this, the TTL-scheduling block below would happily re-arm a
    // fresh TTL on a dead room id.
    if (this.expired || (this.expiresAt > 0 && Date.now() >= this.expiresAt)) {
      this.sendRaw(
        socket,
        JSON.stringify({ kind: "room-expired" } satisfies SignalEnvelope),
      );
      socket.close(4002, "room-expired");
      return;
    }

    // Schedule room expiry on the first ever connection (the initiator). The
    // TTL is fixed for the room's lifetime once set, so only the first peer's
    // requested value matters.
    if (!this.ttlScheduled) {
      this.ttlScheduled = true;
      const ttl = this.resolveTtlSeconds(requestedTtl);
      this.expiresAt = Date.now() + ttl * 1000;
      await this.state.storage.put("expiresAt", this.expiresAt);
      await this.state.storage.setAlarm(this.expiresAt);
    }

    const now = Date.now();
    this.pruneReservations(now);

    // Determine which role this socket should take.
    let role: PeerRole | null = null;

    if (!this.peers.has("initiator")) {
      role = "initiator";
    } else if (!this.peers.has("responder")) {
      role = "responder";
    } else {
      // Both slots are actively occupied -> reject as third peer.
      this.sendRaw(
        socket,
        JSON.stringify({ kind: "room-full" } satisfies SignalEnvelope),
      );
      socket.close(4001, "room-full");
      return;
    }

    const sessionToken = crypto.randomUUID();
    const slot: PeerSlot = { socket, role, sessionToken };
    this.peers.set(role, slot);
    this.reservedRoles.delete(role); // claimed, no longer just reserved

    const peerPresent = this.peers.size === 2;

    // Tell the new peer its role, whether the other peer is already here, and
    // the room's absolute expiry time so the UI can show an accurate countdown.
    this.sendRaw(
      socket,
      JSON.stringify({
        kind: "welcome",
        role,
        peerPresent,
        expiresAt: this.expiresAt,
      } satisfies SignalEnvelope),
    );

    // Notify the other peer that someone joined.
    if (peerPresent) {
      const other = this.otherRole(role);
      const otherSlot = this.peers.get(other);
      if (otherSlot) {
        this.sendRaw(
          otherSlot.socket,
          JSON.stringify({ kind: "peer-joined" } satisfies SignalEnvelope),
        );
      }
    }

    socket.addEventListener("message", (event) => {
      this.onMessage(slot, event);
    });

    const onClose = () => this.onClose(slot);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  }

  /** Relay a peer message to the other peer. Server never reads `data`. */
  private onMessage(from: PeerSlot, event: MessageEvent): void {
    let parsed: SignalEnvelope;
    try {
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      parsed = JSON.parse(text) as SignalEnvelope;
    } catch {
      this.sendRaw(from.socket, makeError("malformed-message"));
      return;
    }

    // The only message kind a peer is allowed to send is `signal`.
    // Everything else is ignored to keep the relay surface minimal.
    if (parsed.kind !== "signal") {
      return;
    }

    const targetRole = this.otherRole(from.role);
    const target = this.peers.get(targetRole);
    if (!target) {
      // Other peer not present yet; let sender know so it can wait.
      this.sendRaw(
        from.socket,
        JSON.stringify({ kind: "peer-left" } satisfies SignalEnvelope),
      );
      return;
    }

    // Relay verbatim. We deliberately re-serialize ONLY the envelope we trust
    // (kind + data) so no extra fields leak through, but we never look inside
    // `data.payload`.
    this.sendRaw(
      target.socket,
      JSON.stringify({
        kind: "signal",
        data: parsed.data,
      } satisfies SignalEnvelope),
    );
  }

  private onClose(slot: PeerSlot): void {
    // Only remove if this exact socket still owns the role (avoid races with
    // a reconnect that already replaced it).
    const current = this.peers.get(slot.role);
    if (current && current.sessionToken === slot.sessionToken) {
      this.peers.delete(slot.role);

      // Reserve the role briefly so a refresh can reclaim it.
      const grace = this.graceSeconds();
      if (grace > 0) {
        this.reservedRoles.set(slot.role, Date.now() + grace * 1000);
      }

      // Tell the remaining peer the other side left.
      const other = this.peers.get(this.otherRole(slot.role));
      if (other) {
        this.sendRaw(
          other.socket,
          JSON.stringify({ kind: "peer-left" } satisfies SignalEnvelope),
        );
      }
    }

    // If the room is now empty, let the alarm handle final cleanup. We do not
    // proactively destroy here because a reconnect may arrive within grace.
  }

  /**
   * DO alarm — fires twice per room:
   *   Phase 1 (TTL elapsed): close everything, wipe state, and leave a
   *   persisted tombstone so a late connect cannot revive the room id with a
   *   fresh TTL. Schedules phase 2.
   *   Phase 2 (tombstone window over): sweep the tombstone so the DO's storage
   *   returns to fully empty (no per-room residue).
   */
  async alarm(): Promise<void> {
    if (this.expired) {
      // Phase 2: tombstone window over — remove the marker entirely.
      await this.state.storage.deleteAll();
      return;
    }

    // Phase 1: room TTL expired. Close everything and wipe state.
    for (const slot of this.peers.values()) {
      this.sendRaw(
        slot.socket,
        JSON.stringify({ kind: "room-expired" } satisfies SignalEnvelope),
      );
      try {
        slot.socket.close(4002, "room-expired");
      } catch {
        /* socket may already be closed */
      }
    }
    this.peers.clear();
    this.reservedRoles.clear();
    await this.state.storage.deleteAll();

    // Tombstone the room id (persisted so it survives DO eviction) and keep
    // ttlScheduled true so accept() can never re-arm a TTL for this room.
    this.expired = true;
    await this.state.storage.put("expired", true);
    await this.state.storage.setAlarm(Date.now() + SignalingRoom.TOMBSTONE_MS);
  }

  // --- helpers ---------------------------------------------------------------

  private pruneReservations(now: number): void {
    for (const [role, expiry] of this.reservedRoles) {
      if (expiry <= now) this.reservedRoles.delete(role);
    }
  }

  private otherRole(role: PeerRole): PeerRole {
    return otherRole(role);
  }

  private sendRaw(socket: WebSocket, data: string): void {
    try {
      socket.send(data);
    } catch {
      /* peer gone; ignore */
    }
  }
}
