/**
 * session.ts — end-to-end session orchestrator (framework-agnostic).
 *
 * Drives the full handshake + transfer for either side:
 *
 *   SENDER (initiator)
 *     create room -> connect signaling -> wait for peer -> on peer-joined:
 *       generate salt, send our ECDH public key + salt, start WebRTC offer ->
 *       receive peer public key -> derive AES key -> on channel open: send file.
 *
 *   RECEIVER (responder)
 *     connect signaling -> on welcome: generate keypair ->
 *       receive initiator public key + salt -> adopt salt, send our public key
 *       -> derive AES key -> receive file -> offer download.
 *
 * SECURITY: the salt is NOT secret (it's a public HKDF salt) and is exchanged
 * over signaling, never the AES key or private keys. The optional passphrase is
 * NEVER transmitted; both users must know it out-of-band.
 */

import {
  deriveSharedAesKey,
  exportPublicKey,
  generateEcdhKeyPair,
  importPublicKey,
  pairFingerprint,
  randomBytes,
  EcdhKeyPair,
} from "./crypto";
import { createRoom, PeerRole, SignalingClient } from "./signaling";
import { ConnectionType, WebRtcManager } from "./webrtc";
import { FileReceiver, FileSender, ReceivedItem, TransferProgress } from "./transfer";
import { bytesToBase64Url } from "./crypto";
import { APP_BASE_URL, fetchIceServers, SIGNAL_URL } from "./config";
import { canStreamToDisk, createFileSink, FileSink } from "./file-sink";
import {
  downloadStored,
  downloadStoredToDisk,
  canStreamStored,
  burnStored,
  uploadStored,
} from "./store-transfer";

/**
 * Minimum single-file size before we OFFER live streaming-to-disk. Below this,
 * the in-memory path is simpler (instant preview, Save to Photos, etc.) and the
 * memory cost is trivial; above it, streaming avoids holding the whole file in
 * RAM. 256 MiB is comfortably within memory yet well below problem territory.
 */
const LIVE_STREAM_MIN_BYTES = 256 * 1024 * 1024;

export type SessionPhase =
  | "idle"
  | "creating-room"
  | "waiting-for-peer"
  | "peer-connected"
  | "key-exchange"
  | "connecting-webrtc"
  | "transferring"
  | "uploading"
  | "stored"
  | "downloading"
  | "ready-to-save"
  | "complete"
  | "error"
  | "expired"
  | "cancelled"
  | "peer-left";

/** Whether a session uses live P2P or store-and-forward (R2). */
export type TransferMode = "live" | "store";

export interface SessionState {
  phase: SessionPhase;
  role: PeerRole | null;
  roomId: string | null;
  inviteUrl: string | null;
  fingerprint: string | null;
  progress: TransferProgress | null;
  error: string | null;
  /** Received items (files / text), available to the receiver on completion. */
  receivedFiles: ReceivedItem[];
  requiresPassphrase: boolean;
  /** Absolute epoch-ms time the room/invite expires (from the server). */
  expiresAt: number | null;
  /** True while the signaling socket dropped and we're transparently retrying. */
  reconnecting: boolean;
  /** True while WebRTC is restarting ICE to recover a dropped connection. */
  recoveringConnection: boolean;
  /** Sender-only: receiver confirmed full delivery. */
  delivered: boolean;
  /** Number of items queued to send (sender) or expected (receiver). */
  itemCount: number;
  /** How the peers are connected once ICE settles: direct P2P or via TURN relay. */
  connectionType: ConnectionType | null;
  /** Whether this session is live P2P or store-and-forward. */
  transferMode: TransferMode;
  /**
   * Store-mode only: when true, the transfer can be streamed straight to disk
   * (single file + File System Access API). The UI offers a gesture button
   * instead of auto-downloading, so very large files don't fill memory.
   */
  canStreamToDisk: boolean;
  /** Store-mode only: true once a streamed-to-disk save has completed. */
  savedToDisk: boolean;
}

export type SessionListener = (state: SessionState) => void;

export class TransferSession {
  private state: SessionState = {
    phase: "idle",
    role: null,
    roomId: null,
    inviteUrl: null,
    fingerprint: null,
    progress: null,
    error: null,
    receivedFiles: [],
    requiresPassphrase: false,
    expiresAt: null,
    reconnecting: false,
    recoveringConnection: false,
    delivered: false,
    itemCount: 0,
    connectionType: null,
    transferMode: "live",
    canStreamToDisk: false,
    savedToDisk: false,
  };

  private listeners = new Set<SessionListener>();

  private signaling: SignalingClient | null = null;
  private rtc: WebRtcManager | null = null;
  private keyPair: EcdhKeyPair | null = null;
  private aesKey: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private passphrase: string | undefined;
  /** Initiator-chosen room TTL in seconds (passed to the signaling server). */
  private ttlSeconds: number | undefined;
  /**
   * High-entropy secret carried ONLY in the invite link's URL fragment. It is
   * mixed into key derivation so a malicious signaling relay (which never sees
   * the fragment) cannot MITM the public-key exchange. Never transmitted.
   */
  private linkSecret: string | undefined;

  private files: File[] = [];
  /**
   * Transfer direction, fixed when the session starts: "send" (we hold the
   * file and create the WebRTC offer) or "receive" (we answer and receive).
   * This is DECOUPLED from the signaling server's connection-order slot
   * (initiator/responder) — otherwise, if the sender leaves and the receiver
   * connects first, the slots invert and the transfer stalls.
   */
  private direction: "send" | "receive" | null = null;
  /** Store-and-forward receive params (kept for a gesture-triggered download). */
  private storeId: string | null = null;
  /**
   * Store-mode burn-after-download: the id to burn ONCE the user confirms they
   * saved the file. Held pending so a failed save (e.g. inside an in-app
   * browser) doesn't destroy the only copy. Null when there's nothing to burn.
   */
  private pendingBurnId: string | null = null;
  /**
   * Live streaming-to-disk: resolver for the deferred save-location gesture.
   * The FileReceiver's openSink factory parks here (returning a pending
   * Promise) while we ask the user to pick a location; `chooseLiveSaveLocation`
   * fulfills it from a real user gesture so `showSaveFilePicker` is allowed.
   */
  private liveSinkResolve: ((sink: FileSink | null) => void) | null = null;
  /** The single-file info awaiting a save-location choice (live streaming). */
  private liveSinkInfo: { name: string; size: number; mime: string } | null = null;
  /** Aborts an in-progress store upload when the user cancels. */
  private uploadAbort: AbortController | null = null;
  private sender: FileSender | null = null;
  private receiver: FileReceiver | null = null;
  private peerPublicRaw: Uint8Array | null = null;
  private startedHandshake = false;

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l(this.state);
  }

  get snapshot(): SessionState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // SENDER entry point
  // -------------------------------------------------------------------------

  /**
   * Start a sending session for one or more files.
   *
   * @param mode  "live" (default, secure P2P, both online) or "store"
   *              (store-and-forward: encrypted blob parked in R2 so the
   *              recipient can download later).
   */
  async startSend(
    files: File | File[],
    passphrase?: string,
    ttlSeconds?: number,
    mode: TransferMode = "live",
    burn = false,
  ): Promise<void> {
    if (mode === "store") {
      return this.startStoreSend(files, passphrase, burn);
    }
    try {
      const list = Array.isArray(files) ? files : [files];
      if (list.length === 0) throw new Error("No files selected");
      this.direction = "send";
      this.files = list;
      this.passphrase = passphrase && passphrase.length > 0 ? passphrase : undefined;
      this.ttlSeconds =
        typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds)
          ? ttlSeconds
          : undefined;
      this.patch({
        phase: "creating-room",
        requiresPassphrase: !!this.passphrase,
        itemCount: list.length,
        transferMode: "live",
      });

      // 1. Create a fresh random room on the signaling server.
      const roomId = await createRoom(SIGNAL_URL);

      // 2. Generate ephemeral ECDH key pair + HKDF salt (initiator owns salt).
      this.keyPair = await generateEcdhKeyPair();
      this.salt = randomBytes(16);

      // 2b. Generate the link secret: 32 bytes (~256 bits) of CSPRNG entropy.
      //     This goes into the invite link fragment ONLY and is folded into the
      //     derived key, defeating a signaling-relay MITM (the server never
      //     sees URL fragments). It is independent of the optional passphrase.
      this.linkSecret = bytesToBase64Url(randomBytes(32));

      // 3. Build the invite link: room ID + link secret in the URL fragment,
      //    so neither is ever sent to the server in HTTP requests.
      const inviteUrl = buildInviteUrl(roomId, this.linkSecret, !!this.passphrase);

      this.patch({
        role: "initiator",
        roomId,
        inviteUrl,
        phase: "waiting-for-peer",
      });

      // 4. Connect to signaling and wait for the receiver.
      this.connectSignaling(roomId);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Store-and-forward send: encrypt locally, upload ciphertext to R2, and
   * surface a link the recipient can open later (even after the sender leaves).
   */
  private async startStoreSend(
    files: File | File[],
    passphrase?: string,
    burn = false,
  ): Promise<void> {
    try {
      const list = Array.isArray(files) ? files : [files];
      if (list.length === 0) throw new Error("No files selected");
      this.files = list;
      this.passphrase = passphrase && passphrase.length > 0 ? passphrase : undefined;
      this.linkSecret = bytesToBase64Url(randomBytes(32));
      this.salt = randomBytes(16);
      this.uploadAbort = new AbortController();
      this.patch({
        role: "initiator",
        transferMode: "store",
        requiresPassphrase: !!this.passphrase,
        itemCount: list.length,
        phase: "uploading",
      });

      const { id, expiresAt } = await uploadStored({
        files: list,
        linkSecret: this.linkSecret,
        passphrase: this.passphrase,
        salt: this.salt,
        burn,
        signal: this.uploadAbort.signal,
        onProgress: (p) => this.patch({ progress: p }),
      });

      const inviteUrl = buildStoreInviteUrl(id, this.linkSecret, !!this.passphrase);
      this.patch({
        roomId: id,
        inviteUrl,
        expiresAt,
        phase: "stored",
        delivered: true, // upload finished; recipient can fetch anytime
      });
      // Sensitive material no longer needed in memory.
      if (this.salt) this.salt.fill(0);
      this.linkSecret = undefined;
      this.passphrase = undefined;
    } catch (err) {
      if (err instanceof Error && err.message === "cancelled") {
        this.patch({ phase: "cancelled" });
        return;
      }
      this.fail(err);
    }
  }

  // -------------------------------------------------------------------------
  // RECEIVER entry point
  // -------------------------------------------------------------------------

  /** Join an existing room as the receiver. */
  async startReceive(
    roomId: string,
    linkSecret?: string,
    passphrase?: string,
  ): Promise<void> {
    try {
      this.direction = "receive";
      this.linkSecret = linkSecret && linkSecret.length > 0 ? linkSecret : undefined;
      this.passphrase = passphrase && passphrase.length > 0 ? passphrase : undefined;
      this.keyPair = await generateEcdhKeyPair();
      this.patch({
        role: "responder",
        roomId,
        phase: "waiting-for-peer",
      });
      this.connectSignaling(roomId);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Store-and-forward receive: download the encrypted blob and decrypt it
   * locally using the link secret (+ passphrase). No live peer needed.
   *
   * If the browser supports streaming-to-disk for this (single-file) transfer,
   * we DON'T download immediately — we flag `canStreamToDisk` and wait for a
   * user gesture (see `downloadToDisk`), since the save-file picker requires
   * one. Otherwise we reassemble in memory and surface the items for preview.
   */
  async startStoreReceive(
    storeId: string,
    linkSecret?: string,
    passphrase?: string,
  ): Promise<void> {
    try {
      if (!linkSecret) throw new Error("This link is incomplete (missing key).");
      this.storeId = storeId;
      this.linkSecret = linkSecret;
      this.passphrase = passphrase && passphrase.length > 0 ? passphrase : undefined;
      this.patch({
        role: "responder",
        roomId: storeId,
        transferMode: "store",
        phase: "downloading",
      });

      // Prefer streaming-to-disk for large single-file transfers when supported.
      const streamable = await canStreamStored(storeId, linkSecret, this.passphrase);
      if (streamable) {
        // Wait for a user gesture; the picker can't open automatically.
        this.patch({ phase: "ready-to-save", canStreamToDisk: true });
        return;
      }

      const result = await downloadStored({
        id: storeId,
        linkSecret,
        passphrase: this.passphrase,
        onProgress: (p) => this.patch({ progress: p }),
      });
      // Defer burn-after-download until the user confirms a save (see
      // confirmSaved). In an in-app browser the decrypt can succeed but the
      // save can fail, so we must not destroy the only copy yet.
      this.pendingBurnId = result.burn ? storeId : null;
      this.patch({ receivedFiles: result.items, phase: "complete" });
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Gesture-triggered streaming download to disk (store mode). Opens the
   * save-file picker and streams decrypted bytes straight to the chosen file.
   */
  async downloadToDisk(): Promise<void> {
    if (!this.storeId || !this.linkSecret) return;
    try {
      this.patch({ phase: "downloading" });
      const result = await downloadStoredToDisk({
        id: this.storeId,
        linkSecret: this.linkSecret,
        passphrase: this.passphrase,
        onProgress: (p) => this.patch({ progress: p }),
      });
      this.patch({ phase: "complete", savedToDisk: result.savedToDisk });
    } catch (err) {
      // If the user cancelled the picker, return them to the ready state.
      if (err instanceof DOMException && err.name === "AbortError") {
        this.patch({ phase: "ready-to-save" });
        return;
      }
      this.fail(err);
    }
  }

  /**
   * Confirm the recipient has actually saved an in-memory store-mode download
   * to their device. Only NOW do we fire a deferred burn-after-download, so a
   * failed save (common in in-app browsers) never destroys the only copy.
   * Idempotent and best-effort: safe to call more than once.
   */
  confirmSaved(): void {
    const id = this.pendingBurnId;
    if (!id) return;
    this.pendingBurnId = null;
    void burnStored(id);
  }

  // -------------------------------------------------------------------------
  // Signaling wiring
  // -------------------------------------------------------------------------

  private connectSignaling(roomId: string): void {
    this.signaling = new SignalingClient(
      SIGNAL_URL,
      roomId,
      {
        onWelcome: (_role, peerPresent, expiresAt) => {
          // NOTE: we deliberately ignore the server-assigned slot role here.
          // Transfer direction (send/receive) is fixed at session start and is
          // independent of connection order — otherwise a sender who left and
          // rejoined after the receiver would have its role inverted and stall.
          if (expiresAt && expiresAt > 0) this.patch({ expiresAt });
          // If the other peer is already present, we can begin immediately.
          if (peerPresent) this.onPeerReady();
        },
        onPeerJoined: () => this.onPeerReady(),
        onSignal: (data) => this.rtc?.handleSignal(data),
        onPeerLeft: () => this.onPeerLeft(),
        onRoomFull: () =>
          this.fail(new Error("Room is full — a transfer is already in progress.")),
        onRoomExpired: () => this.patch({ phase: "expired" }),
        onError: (reason) => {
          // The signaling client now recovers socket drops internally via
          // reconnection, so a surfaced error here is a server-level protocol
          // error. Never fatal once a transfer is running on the P2P channel.
          if (this.state.phase !== "transferring" && this.state.phase !== "complete") {
            this.fail(new Error(`Signaling error: ${reason}`));
          }
        },
        onReconnecting: () => {
          // Transparent recovery: flag it (the UI can show a subtle hint) but
          // do NOT change the phase or fail. Common on mobile when the user
          // backgrounds the tab to share the invite link.
          if (!this.state.reconnecting) this.patch({ reconnecting: true });
        },
        onReconnected: () => {
          if (this.state.reconnecting) this.patch({ reconnecting: false });
        },
        onClose: () => {
          // Only reached after reconnection attempts are exhausted (sustained
          // outage). Before a transfer this means we lost the peer/room.
          this.patch({ reconnecting: false });
          if (
            this.state.phase !== "complete" &&
            this.state.phase !== "transferring" &&
            this.state.phase !== "error"
          ) {
            this.patch({ phase: "peer-left" });
          }
        },
      },
      // Only the SENDER's requested TTL matters (it owns the room).
      this.direction === "send" ? this.ttlSeconds : undefined,
    );

    this.signaling.connect();
  }

  /** Both peers are present in the room. Build WebRTC + exchange keys. */
  private onPeerReady(): void {
    if (this.startedHandshake) return;
    this.startedHandshake = true;
    this.patch({ phase: "peer-connected" });
    void this.setupWebRtc();
  }

  /**
   * The other peer's signaling connection dropped. How we react depends on how
   * far along we are:
   *
   *   - Transfer running or complete: ignore. The bytes ride the P2P
   *     DataChannel, not signaling, and completion is confirmed by the ack.
   *   - Still handshaking (initiator waiting): this is almost always a transient
   *     visitor — a link-preview crawler (iMessage/Slack/WhatsApp unfurling the
   *     URL), a double-open, or a refresh — that briefly took the receiver slot
   *     then left. We tear down the half-built WebRTC, reset, and return to
   *     "waiting for peer" so the REAL receiver can still connect. The room and
   *     invite remain valid until expiry.
   */
  private onPeerLeft(): void {
    const phase = this.state.phase;
    if (phase === "complete" || phase === "transferring" || phase === "error") {
      return;
    }

    // The SENDER owns the room and the file, so it keeps waiting for the
    // recipient to (re)connect — resetting any half-built handshake so the
    // next connection starts cleanly.
    if (this.direction === "send") {
      this.resetHandshakeAndWait();
      return;
    }

    // A receiver that loses the sender pre-transfer goes back to waiting too,
    // so the sender returning triggers a fresh handshake rather than a stall.
    this.resetHandshakeAndWait();
  }

  /**
   * Tear down the partially-established WebRTC/keys and go back to waiting for
   * a peer, WITHOUT closing the signaling socket or destroying the room.
   */
  private resetHandshakeAndWait(): void {
    try {
      this.rtc?.close();
    } catch {
      /* ignore */
    }
    this.rtc = null;
    this.sender = null;
    this.receiver = null;
    this.aesKey = null;
    this.peerPublicRaw = null;
    this.startedHandshake = false;
    // Keep our keypair + salt + linkSecret; they're still valid for the room.
    this.patch({ phase: "waiting-for-peer", progress: null, connectionType: null });
  }

  private async setupWebRtc(): Promise<void> {
    if (!this.signaling || !this.keyPair) return;
    // The WebRTC offerer/answerer split is driven by transfer DIRECTION, not
    // the signaling slot: the sender always offers, the receiver always
    // answers. Both peers know their own direction, so this is deterministic
    // regardless of who connected to the room first.
    const role: "initiator" | "responder" =
      this.direction === "send" ? "initiator" : "responder";

    // Fetch ICE servers (incl. short-lived TURN credentials) from the Worker.
    // TURN lets peers behind symmetric/carrier-grade NAT connect.
    const iceServers = await fetchIceServers();
    if (!this.signaling || this.state.phase === "error") return; // torn down meanwhile

    this.rtc = new WebRtcManager(role, this.signaling, iceServers, {
      onPeerPublicKey: (rawKey, salt) => {
        void this.onPeerPublicKey(rawKey, salt);
      },
      onChannelOpen: () => this.onChannelOpen(),
      onMessage: (data) => {
        // Binary frames + metadata/complete go to the receiver; ack/nack
        // control strings go to the sender. Route to whichever side exists.
        this.receiver?.handleMessage(data);
        if (this.sender && typeof data === "string") {
          try {
            this.sender.handleControl(JSON.parse(data));
          } catch {
            /* ignore non-JSON on the sender side */
          }
        }
      },
      onIceRestart: () => {
        if (this.isActivePhase()) this.patch({ recoveringConnection: true });
      },
      onConnectionType: (type) => {
        this.patch({ connectionType: type });
      },
      onConnectionStateChange: (s) => {
        if (s === "connected" && this.state.recoveringConnection) {
          this.patch({ recoveringConnection: false });
        }
        // Only treat a failure as fatal while we still need the connection.
        if (s === "failed" && this.isActivePhase()) {
          this.fail(new Error("WebRTC connection failed."));
        }
      },
      onError: (e) => {
        // A DataChannel error during/after teardown is expected and must not
        // overwrite a completed/failed status or abort a finished transfer.
        if (this.isActivePhase()) {
          this.fail(new Error(e));
        }
      },
    });

    this.patch({ phase: "key-exchange" });

    // Initiator immediately offers its public key + salt and starts the offer.
    if (role === "initiator") {
      void this.sendOurPublicKey();
      void this.rtc.start();
    }
    // Responder waits for the initiator's public key (which carries the salt),
    // then replies with its own public key (see onPeerPublicKey).
  }

  private async sendOurPublicKey(): Promise<void> {
    if (!this.rtc || !this.keyPair) return;
    if (!this.salt) this.salt = randomBytes(16);
    const raw = await exportPublicKey(this.keyPair.publicKey);
    this.rtc.sendPublicKey(raw, this.salt);
  }

  private async onPeerPublicKey(rawKey: Uint8Array, salt: Uint8Array): Promise<void> {
    try {
      this.peerPublicRaw = rawKey;

      // The RECEIVER adopts the sender's salt, then replies with its own
      // public key. The sender already sent its key + salt when it offered.
      if (this.direction === "receive") {
        this.salt = salt;
        await this.sendOurPublicKey();
      }

      if (!this.keyPair || !this.salt) return;

      // Derive the shared AES-256-GCM key. The link secret + optional
      // passphrase are folded into the key-derivation IKM so a signaling-relay
      // MITM (which never sees them) cannot derive the same key.
      const peerPublic = await importPublicKey(rawKey);
      this.aesKey = await deriveSharedAesKey(
        this.keyPair.privateKey,
        peerPublic,
        this.salt,
        this.passphrase,
        this.linkSecret,
      );

      // Compute the Short Authentication String over BOTH public keys (canonical
      // order), so the sender and receiver display an IDENTICAL value. Users can
      // compare it out-of-band to detect a signaling-relay MITM. Both peers now
      // show it (previously only the sender did, and over its own key alone —
      // which gave nothing to compare).
      try {
        const ourRaw = await exportPublicKey(this.keyPair.publicKey);
        const fp = await pairFingerprint(ourRaw, rawKey);
        this.patch({ fingerprint: fp });
      } catch {
        /* fingerprint is a UX aid; never block the transfer on it */
      }

      this.patch({ phase: "connecting-webrtc" });
      // Channel open handler kicks off the actual transfer.
      this.maybeStartTransfer();
    } catch (err) {
      this.fail(err);
    }
  }

  private onChannelOpen(): void {
    this.maybeStartTransfer();
  }

  /** Start the transfer once BOTH the AES key and the open channel exist. */
  private maybeStartTransfer(): void {
    if (!this.aesKey || !this.rtc) return;
    if (this.rtc.dataChannel?.readyState !== "open") return;
    if (this.sender || this.receiver) return; // already started

    if (this.direction === "send" && this.files.length > 0) {
      this.patch({ phase: "transferring" });
      this.sender = new FileSender({
        rtc: this.rtc,
        key: this.aesKey,
        files: this.files,
        onProgress: (p) => this.patch({ progress: p }),
        onDone: () => {
          this.patch({ delivered: true });
          this.onTransferComplete();
        },
        onError: (e) => this.fail(new Error(e)),
      });
      void this.sender.send();
    } else if (this.direction === "receive") {
      this.patch({ phase: "transferring" });
      this.receiver = new FileReceiver({
        key: this.aesKey,
        rtc: this.rtc,
        onProgress: (p) => this.patch({ progress: p }),
        onComplete: (items) => {
          this.patch({ receivedFiles: items });
          this.onTransferComplete();
        },
        onError: (e) => this.fail(new Error(e)),
        // Live streaming-to-disk: for a large SINGLE-file transfer on a browser
        // that supports the File System Access API, stream straight to disk so
        // the whole file never has to fit in memory. The picker needs a user
        // gesture, so we park here and let the UI drive `chooseLiveSaveLocation`
        // (or skip to in-memory). Returns null => buffer in memory.
        openSink: (info) => this.requestLiveSink(info),
      });
    }
  }

  /**
   * Called by the FileReceiver when a single-file live transfer arrives and a
   * disk sink *could* be opened. We only OFFER streaming for large files on
   * capable browsers; otherwise we resolve null immediately (buffer in memory,
   * which keeps small-file UX — preview, Save to Photos — intact).
   *
   * When we do offer it, we surface a `ready-to-save` gesture and return a
   * pending promise; `chooseLiveSaveLocation` / `skipLiveSaveLocation` settle
   * it. The sender waits (up to its 5-minute ready timeout) meanwhile.
   */
  private requestLiveSink(info: {
    name: string;
    size: number;
    mime: string;
  }): Promise<FileSink | null> {
    if (!canStreamToDisk() || info.size < LIVE_STREAM_MIN_BYTES) {
      return Promise.resolve(null); // buffer in memory
    }
    this.liveSinkInfo = info;
    this.patch({ phase: "ready-to-save", canStreamToDisk: true });
    return new Promise<FileSink | null>((resolve) => {
      this.liveSinkResolve = resolve;
    });
  }

  /**
   * User gesture: pick a save location for a large live transfer and stream to
   * disk. MUST be called from a click/tap so the save-file picker can open.
   * Falls back to in-memory if the user dismisses the picker.
   */
  async chooseLiveSaveLocation(): Promise<void> {
    const resolve = this.liveSinkResolve;
    const info = this.liveSinkInfo;
    if (!resolve || !info) return;
    this.liveSinkResolve = null;
    this.liveSinkInfo = null;
    let sink: FileSink | null = null;
    try {
      sink = await createFileSink(info.name, info.mime, true);
    } catch {
      sink = null;
    }
    // If the user dismissed the picker we get a memory sink; either way the
    // transfer proceeds. Reflect the streaming phase in the UI.
    this.patch({ phase: "transferring" });
    resolve(sink);
  }

  /**
   * User gesture/choice: skip streaming-to-disk and receive into memory
   * (e.g. they'd rather preview/share). Resolves the parked sink request null.
   */
  skipLiveSaveLocation(): void {
    const resolve = this.liveSinkResolve;
    if (!resolve) return;
    this.liveSinkResolve = null;
    this.liveSinkInfo = null;
    this.patch({ phase: "transferring" });
    resolve(null);
  }

  /** Cancel an in-progress (or waiting) transfer and notify the peer. */
  cancel(): void {
    try {
      this.sender?.abort("Sender cancelled the transfer");
    } catch {
      /* ignore */
    }
    // Abort an in-flight store-and-forward upload, if any.
    try {
      this.uploadAbort?.abort();
    } catch {
      /* ignore */
    }
    this.patch({ phase: "cancelled" });
    this.cleanupAfterTransfer();
  }

  private onTransferComplete(): void {
    // If the (single-file) live transfer was streamed straight to disk, the
    // received item has no in-memory blob; reflect that so the UI shows the
    // "saved to your device" confirmation instead of a download button.
    const streamed =
      this.state.receivedFiles.length > 0 &&
      this.state.receivedFiles.every((it) => it.savedToDisk);
    this.patch({ phase: "complete", savedToDisk: streamed });
    // Destroy the room + clear sensitive material after success.
    this.cleanupAfterTransfer();
  }

  private fail(err: unknown): void {
    let message = err instanceof Error ? err.message : "Unknown error";
    // Map the receiver's decrypt-failure marker to actionable guidance. A wrong
    // AES key in live mode is almost always a wrong passphrase or a tampered /
    // incomplete invite link (the link secret is part of the key).
    if (message === "decrypt-failed") {
      message = this.passphrase
        ? "Couldn't decrypt — the passphrase looks wrong. Double-check it with the sender and try the link again."
        : "Couldn't decrypt the file. The invite link may be incomplete or altered — ask the sender to resend it.";
    }
    this.patch({ phase: "error", error: message });
    this.cleanupAfterTransfer();
  }

  /**
   * True while a failure should still be surfaced. We only suppress errors
   * once we've reached a terminal phase (complete/error/expired/peer-left).
   * Genuine mid-transfer failures stay fatal; with the completion ack, both
   * peers are already in `complete` by the time the channel tears down, so
   * teardown-time DataChannel errors are correctly ignored.
   */
  private isActivePhase(): boolean {
    const p = this.state.phase;
    return (
      p !== "complete" &&
      p !== "error" &&
      p !== "expired" &&
      p !== "cancelled" &&
      p !== "peer-left"
    );
  }

  /**
   * Tear down the session: close signaling (destroys room server-side once
   * empty / on expiry), close WebRTC, and best-effort wipe sensitive buffers.
   * The non-extractable CryptoKeys are dropped for GC; their raw bytes never
   * existed in JS memory.
   */
  private cleanupAfterTransfer(): void {
    try {
      this.signaling?.close();
    } catch {
      /* ignore */
    }
    // Keep RTC briefly so final buffered frames flush, then close.
    setTimeout(() => {
      try {
        this.rtc?.close();
      } catch {
        /* ignore */
      }
    }, 500);

    if (this.salt) this.salt.fill(0);
    if (this.peerPublicRaw) this.peerPublicRaw.fill(0);
    this.aesKey = null;
    this.keyPair = null;
    this.passphrase = undefined;
    this.linkSecret = undefined;
  }

  /** Explicit teardown for component unmount / cancel. */
  destroy(): void {
    this.cleanupAfterTransfer();
    try {
      this.rtc?.close();
    } catch {
      /* ignore */
    }
    this.listeners.clear();
  }
}

/**
 * Build an invite URL with the room id AND the link secret in the fragment.
 *
 * Everything after `#` is the URL fragment, which browsers NEVER send to a
 * server in any HTTP request. So both the room id and the high-entropy link
 * secret stay client-side and out of the signaling server's view.
 *
 *   Live P2P:          https://app/#/r/<roomId>/k/<linkSecret>[?p=1]
 *   Store-and-forward: https://app/#/s/<storeId>/k/<linkSecret>[?p=1]
 */
export function buildInviteUrl(
  roomId: string,
  linkSecret: string,
  requiresPassphrase: boolean,
): string {
  const base = APP_BASE_URL.replace(/\/+$/, "");
  const query = requiresPassphrase ? "?p=1" : "";
  return `${base}/#/r/${encodeURIComponent(roomId)}/k/${encodeURIComponent(
    linkSecret,
  )}${query}`;
}

/** Build a store-and-forward invite URL (recipient can fetch it later). */
export function buildStoreInviteUrl(
  storeId: string,
  linkSecret: string,
  requiresPassphrase: boolean,
): string {
  const base = APP_BASE_URL.replace(/\/+$/, "");
  const query = requiresPassphrase ? "?p=1" : "";
  return `${base}/#/s/${encodeURIComponent(storeId)}/k/${encodeURIComponent(
    linkSecret,
  )}${query}`;
}

/**
 * Parse an invite from the location hash. Supports both live (`/r/`) and
 * store-and-forward (`/s/`) links, each with a link secret.
 */
export function parseInviteFromHash(hash: string): {
  kind: "live" | "store";
  roomId: string;
  linkSecret?: string;
  requiresPassphrase: boolean;
} | null {
  // Store-and-forward: #/s/<storeId>/k/<linkSecret>[?...]
  const store = hash.match(/^#\/s\/([^/?]+)\/k\/([^?]+)(?:\?(.*))?$/);
  if (store) {
    const params = new URLSearchParams(store[3] ?? "");
    return {
      kind: "store",
      roomId: decodeURIComponent(store[1]),
      linkSecret: decodeURIComponent(store[2]),
      requiresPassphrase: params.get("p") === "1",
    };
  }
  // Live P2P with link secret: #/r/<roomId>/k/<linkSecret>[?...]
  const withKey = hash.match(/^#\/r\/([^/?]+)\/k\/([^?]+)(?:\?(.*))?$/);
  if (withKey) {
    const params = new URLSearchParams(withKey[3] ?? "");
    return {
      kind: "live",
      roomId: decodeURIComponent(withKey[1]),
      linkSecret: decodeURIComponent(withKey[2]),
      requiresPassphrase: params.get("p") === "1",
    };
  }
  // Legacy / no-secret: #/r/<roomId>[?...]
  const m = hash.match(/^#\/r\/([^/?]+)(?:\?(.*))?$/);
  if (!m) return null;
  const params = new URLSearchParams(m[2] ?? "");
  return {
    kind: "live",
    roomId: decodeURIComponent(m[1]),
    requiresPassphrase: params.get("p") === "1",
  };
}
