/**
 * transfer.ts — orchestrates an encrypted transfer of one or more items over a
 * DataChannel.
 *
 * An "item" is a file or a text snippet (sent as a text/plain blob). Items are
 * transmitted SEQUENTIALLY over a single channel. Each item has its own random
 * transferId, so the per-chunk AES-GCM AAD already isolates one item's chunks
 * from another's — no cross-item confusion is possible.
 *
 * Protocol (sender -> receiver):
 *   manifest         { totalItems, totalBytes }
 *   for each item:
 *     metadata       { meta }                 // begins an item
 *     <frames…>      [IV][chunkIndex][ct]     // encrypted chunks
 *     file-complete                           // item fully sent
 *   complete-all                              // whole transfer sent
 *
 * Receiver -> sender:
 *   ack              // everything received, decrypted, reassembled
 *   nack { reason }  // failed on the receiving side
 *
 * Either side may send `abort { reason }`.
 *
 * Only encrypted frames cross the wire. The AES key lives only in memory and is
 * wiped when the transfer ends.
 */

import { decryptChunk, encryptChunk, generateIV } from "./crypto";
import {
  buildChunkAAD,
  DEFAULT_CHUNK_SIZE,
  FileMetadata,
  packFrame,
  readFileChunks,
  unpackFrame,
} from "./chunker";
import { WebRtcManager } from "./webrtc";
import type { FileSink } from "./file-sink";

export interface TransferProgress {
  /** Bytes processed so far (plaintext, across all items). */
  bytes: number;
  /** Total bytes across all items. */
  totalBytes: number;
  /** Items fully processed. */
  items: number;
  /** Total items. */
  totalItems: number;
  /** Name of the item currently being processed. */
  currentName: string;
  /** Instantaneous speed in bytes/sec (smoothed). */
  bytesPerSecond: number;
  /** Estimated seconds remaining (Infinity if unknown). */
  etaSeconds: number;
  /** 0..1 fraction complete (overall). */
  fraction: number;
}

/** A received item ready to save. `blob` is null when the item was streamed
 *  straight to disk (no in-memory copy). */
export interface ReceivedItem {
  blob: Blob | null;
  meta: FileMetadata;
  /** True if this item was streamed straight to disk (no in-memory blob). */
  savedToDisk?: boolean;
}

/** High-water mark for DataChannel buffering before we pause sending. */
const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4 MiB
const BUFFER_LOW_WATER = 1 * 1024 * 1024; // 1 MiB

type ControlMessage =
  | { kind: "manifest"; totalItems: number; totalBytes: number; files?: ItemInfo[] }
  | { kind: "metadata"; meta: FileMetadata }
  | { kind: "file-complete" }
  | { kind: "complete-all" }
  /** Receiver -> sender: open the gates, I'm ready to receive file data. */
  | { kind: "receiver-ready" }
  /** Receiver -> sender: everything received, decrypted, reassembled. */
  | { kind: "ack" }
  /** Receiver -> sender: transfer failed on the receiving side. */
  | { kind: "nack"; reason?: string }
  | { kind: "abort"; reason?: string };

/** Lightweight per-item descriptor shared up-front so the receiver can decide
 *  whether to stream a (single, large) file straight to disk. */
export interface ItemInfo {
  name: string;
  size: number;
  mime: string;
}

/**
 * How long the sender waits for the receiver's `ack` after `complete-all`
 * before giving up. Bytes are already delivered reliably over the ordered
 * channel; this is just the completion handshake.
 */
const ACK_TIMEOUT_MS = 30_000;

/**
 * How long the sender waits for the receiver's `receiver-ready` after the
 * manifest before starting to send anyway. Generous, because the receiver may
 * be waiting on a human to pick a save location for a streamed-to-disk file.
 */
const READY_TIMEOUT_MS = 5 * 60_000;

/** A lightweight rolling speed/ETA estimator. */
class RateMeter {
  private startTime = 0;
  private lastTime = 0;
  private lastBytes = 0;
  private ema = 0; // exponential moving average bytes/sec
  private readonly alpha = 0.3;

  start(): void {
    this.startTime = performance.now();
    this.lastTime = this.startTime;
    this.lastBytes = 0;
    this.ema = 0;
  }

  update(totalBytes: number): number {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    if (dt >= 0.2) {
      const db = totalBytes - this.lastBytes;
      const inst = db / dt;
      this.ema = this.ema === 0 ? inst : this.alpha * inst + (1 - this.alpha) * this.ema;
      this.lastTime = now;
      this.lastBytes = totalBytes;
    }
    return this.ema;
  }

  get bytesPerSecond(): number {
    return this.ema;
  }
}

/** Generate a short random transferId (base64url-ish, no imports needed). */
function randomId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export class FileSender {
  private rtc: WebRtcManager;
  private key: CryptoKey;
  private files: File[];
  private chunkSize: number;
  private totalBytes: number;
  private onProgress: (p: TransferProgress) => void;
  private onDone: () => void;
  private onError: (e: string) => void;
  private aborted = false;
  private meter = new RateMeter();
  private sentBytes = 0;

  private ackResolve: (() => void) | null = null;
  private ackReject: ((err: Error) => void) | null = null;
  private readyResolve: (() => void) | null = null;

  constructor(opts: {
    rtc: WebRtcManager;
    key: CryptoKey;
    files: File[];
    chunkSize?: number;
    onProgress: (p: TransferProgress) => void;
    onDone: () => void;
    onError: (e: string) => void;
  }) {
    this.rtc = opts.rtc;
    this.key = opts.key;
    this.files = opts.files;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.totalBytes = this.files.reduce((n, f) => n + f.size, 0);
    this.onProgress = opts.onProgress;
    this.onDone = opts.onDone;
    this.onError = opts.onError;
  }

  async send(): Promise<void> {
    try {
      this.meter.start();

      // 1. Announce the manifest so the receiver knows how many items + bytes,
      //    plus per-file info so it can choose to stream a big single file to
      //    disk. Then WAIT for the receiver to signal it's ready (it may need
      //    to open a save-file picker first). Older receivers don't send
      //    `receiver-ready`; a short timeout falls back to starting anyway.
      this.rtc.sendControl({
        kind: "manifest",
        totalItems: this.files.length,
        totalBytes: this.totalBytes,
        files: this.files.map((f) => ({
          name: f.name,
          size: f.size,
          mime: f.type || "application/octet-stream",
        })),
      } satisfies ControlMessage);

      await this.waitForReceiverReady();

      // 2. Send each item sequentially.
      for (let i = 0; i < this.files.length; i++) {
        if (this.aborted) return;
        await this.sendOne(this.files[i], i);
      }

      // 3. Flush, announce overall completion, wait for the receiver's ack.
      await this.waitForDrain();
      this.rtc.sendControl({ kind: "complete-all" } satisfies ControlMessage);
      await this.waitForAck();
      this.onDone();
    } catch (err) {
      this.onError(err instanceof Error ? err.message : "send-failed");
    }
  }

  private async sendOne(file: File, index: number): Promise<void> {
    const meta: FileMetadata = {
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      chunkSize: this.chunkSize,
      totalChunks: Math.ceil(file.size / this.chunkSize) || 0,
      transferId: randomId(),
    };

    this.rtc.sendControl({ kind: "metadata", meta } satisfies ControlMessage);

    for await (const { index: chunkIndex, data } of readFileChunks(
      file,
      this.chunkSize,
    )) {
      if (this.aborted) return;

      const iv = generateIV();
      const aad = buildChunkAAD(meta, chunkIndex);
      const ciphertext = await encryptChunk(this.key, iv, data, aad);
      const frame = packFrame(iv, chunkIndex, ciphertext);

      await this.waitForBuffer();
      this.rtc.sendBytes(frame);
      data.fill(0); // wipe plaintext chunk promptly

      this.sentBytes += data.length;
      const bps = this.meter.update(this.sentBytes);
      this.emitProgress(index, file.name, bps);
    }

    await this.waitForDrain();
    this.rtc.sendControl({ kind: "file-complete" } satisfies ControlMessage);
  }

  /** Feed an inbound control message (ack/nack) from the receiver. */
  handleControl(msg: ControlMessage): void {
    if (msg.kind === "receiver-ready") {
      this.readyResolve?.();
      this.readyResolve = null;
    } else if (msg.kind === "ack") {
      this.ackResolve?.();
      this.ackResolve = null;
      this.ackReject = null;
    } else if (msg.kind === "nack") {
      this.ackReject?.(
        new Error(
          `Receiver could not complete the transfer${msg.reason ? `: ${msg.reason}` : ""}`,
        ),
      );
      this.ackResolve = null;
      this.ackReject = null;
    }
  }

  abort(reason?: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.rtc.sendControl({ kind: "abort", reason } satisfies ControlMessage);
    // Unblock any pending ack/ready wait so send() can settle.
    this.readyResolve?.();
    this.readyResolve = null;
    this.ackReject?.(new Error(reason || "Transfer cancelled"));
    this.ackResolve = null;
    this.ackReject = null;
  }

  /**
   * Wait for the receiver's `receiver-ready` (it may be opening a save-file
   * picker to stream a large file to disk). Falls back after a timeout so a
   * receiver that never sends it (older clients) still gets the transfer.
   */
  private waitForReceiverReady(): Promise<void> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      setTimeout(() => {
        if (this.readyResolve) {
          this.readyResolve = null;
          resolve();
        }
      }, READY_TIMEOUT_MS);
    });
  }

  private waitForAck(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ackResolve = resolve;
      this.ackReject = reject;
      setTimeout(() => {
        if (this.ackResolve) {
          this.ackResolve = null;
          this.ackReject = null;
          resolve(); // bytes delivered reliably; treat missing ack as success
        }
      }, ACK_TIMEOUT_MS);
    });
  }

  private waitForBuffer(): Promise<void> {
    if (this.rtc.bufferedAmount < BUFFER_HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const channel = this.rtc.dataChannel;
      if (!channel) return resolve();
      this.rtc.setBufferedAmountLowThreshold(BUFFER_LOW_WATER);
      const onLow = () => {
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.aborted || this.rtc.bufferedAmount === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  private emitProgress(itemIndex: number, currentName: string, bps: number): void {
    const remaining = this.totalBytes - this.sentBytes;
    const eta = bps > 0 ? remaining / bps : Infinity;
    this.onProgress({
      bytes: this.sentBytes,
      totalBytes: this.totalBytes,
      items: itemIndex,
      totalItems: this.files.length,
      currentName,
      bytesPerSecond: bps,
      etaSeconds: eta,
      fraction: this.totalBytes > 0 ? this.sentBytes / this.totalBytes : 1,
    });
  }
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

export class FileReceiver {
  private key: CryptoKey;
  private rtc: WebRtcManager;
  private onProgress: (p: TransferProgress) => void;
  private onComplete: (items: ReceivedItem[]) => void;
  private onError: (e: string) => void;
  /**
   * Optional: open a streaming destination for a SINGLE-file transfer so chunks
   * are written straight to disk (bounded memory). Returns a sink, or null to
   * fall back to in-memory reassembly. Receives the file info from the manifest.
   * May await a user gesture (save-file picker).
   */
  private openSink?: (info: ItemInfo) => Promise<FileSink | null>;

  // Whole-transfer state.
  private totalItems = 0;
  private totalBytes = 0;
  private manifestFiles: ItemInfo[] | null = null;
  private completedItems: ReceivedItem[] = [];
  private bytes = 0; // cumulative across all items
  private meter = new RateMeter();

  // Current-item state.
  private meta: FileMetadata | null = null;
  private chunks: (Uint8Array | undefined)[] = [];
  private receivedChunks = 0;
  /** Active streaming sink for the current item (null = buffer in memory). */
  private sink: FileSink | null = null;
  /** Whether the current item is being streamed straight to disk. */
  private streaming = false;
  /** True once a streamed-to-disk save has finalized. */
  private savedToDisk = false;

  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private done = false;

  constructor(opts: {
    key: CryptoKey;
    rtc: WebRtcManager;
    onProgress: (p: TransferProgress) => void;
    onComplete: (items: ReceivedItem[]) => void;
    onError: (e: string) => void;
    openSink?: (info: ItemInfo) => Promise<FileSink | null>;
  }) {
    this.key = opts.key;
    this.rtc = opts.rtc;
    this.onProgress = opts.onProgress;
    this.onComplete = opts.onComplete;
    this.onError = opts.onError;
    this.openSink = opts.openSink;
  }

  /** Whether the just-completed transfer was streamed straight to disk. */
  get wasSavedToDisk(): boolean {
    return this.savedToDisk;
  }

  /**
   * Feed a raw DataChannel message. Strings = control, binary = frames.
   * Work is enqueued onto a serial chain so async decryptions complete in the
   * same order messages arrive (prevents premature finalization).
   */
  handleMessage(data: ArrayBuffer | string): void {
    const payload: ArrayBuffer | string =
      typeof data === "string" ? data : data.slice(0);

    this.queue = this.queue.then(async () => {
      if (this.failed || this.done) return;
      try {
        if (typeof payload === "string") {
          await this.handleControl(JSON.parse(payload) as ControlMessage);
        } else {
          await this.handleFrame(new Uint8Array(payload));
        }
      } catch (err) {
        this.fail(err instanceof Error ? err.message : "receive-failed");
      }
    });
  }

  private fail(reason: string): void {
    if (this.failed || this.done) return;
    this.failed = true;
    this.rtc.sendControl({ kind: "nack", reason } satisfies ControlMessage);
    this.onError(reason);
  }

  private async handleControl(msg: ControlMessage): Promise<void> {
    switch (msg.kind) {
      case "manifest":
        this.totalItems = msg.totalItems;
        this.totalBytes = msg.totalBytes;
        this.manifestFiles = msg.files ?? null;
        this.meter.start();
        this.emitProgress();
        // If a streaming sink factory was provided and this is a single-file
        // transfer, try to open a disk sink BEFORE telling the sender to start,
        // so large files never have to fit in memory. Then signal readiness.
        await this.prepareSinkAndSignalReady();
        break;
      case "metadata":
        // Begin a new item.
        this.meta = msg.meta;
        // Stream this item straight to disk only when we opened a sink for a
        // single-file transfer; otherwise buffer in memory.
        this.streaming = this.sink !== null && this.totalItems === 1;
        this.chunks = this.streaming ? [] : new Array(msg.meta.totalChunks);
        this.receivedChunks = 0;
        this.emitProgress();
        break;
      case "file-complete":
        await this.finalizeItem();
        break;
      case "complete-all":
        await this.finalizeAll();
        break;
      case "abort":
        await this.abortSink();
        this.fail(`Transfer cancelled by sender${msg.reason ? `: ${msg.reason}` : ""}`);
        break;
      case "receiver-ready":
      case "ack":
      case "nack":
        break; // sender-bound
    }
  }

  /**
   * For a single-file transfer with a streaming sink factory, open the sink
   * (may prompt the user for a save location) and then signal `receiver-ready`.
   * Always signals readiness, even on fallback, so the sender starts.
   */
  private async prepareSinkAndSignalReady(): Promise<void> {
    try {
      if (this.openSink && this.totalItems === 1 && this.manifestFiles?.length === 1) {
        this.sink = await this.openSink(this.manifestFiles[0]);
      }
    } catch {
      this.sink = null; // fall back to in-memory on any sink-open failure
    } finally {
      this.rtc.sendControl({ kind: "receiver-ready" } satisfies ControlMessage);
    }
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    if (!this.meta) throw new Error("Received chunk before metadata");

    const { iv, chunkIndex, ciphertext } = unpackFrame(frame);
    const aad = buildChunkAAD(this.meta, chunkIndex);
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptChunk(this.key, iv, ciphertext, aad);
    } catch {
      // AES-GCM auth failure: the derived key is wrong. In live mode the key
      // comes from ECDH + link secret + optional passphrase, so the usual
      // culprit is a wrong passphrase (or a tampered/incomplete link). Use a
      // recognizable marker the session maps to passphrase-aware guidance.
      throw new Error("decrypt-failed");
    }

    if (this.streaming && this.sink) {
      // Forward-only streaming to disk: the ordered/reliable channel delivers
      // chunks in index order, so we write as they arrive. A gap would mean
      // corruption we can't seek around — fail loudly rather than misassemble.
      if (chunkIndex !== this.receivedChunks) {
        throw new Error(
          `Out-of-order chunk while streaming (expected ${this.receivedChunks}, got ${chunkIndex})`,
        );
      }
      const plainLen = plaintext.length;
      await this.sink.write(plaintext);
      plaintext.fill(0);
      this.receivedChunks += 1;
      this.bytes += plainLen;
    } else {
      if (this.chunks[chunkIndex] === undefined) {
        this.receivedChunks += 1;
        this.bytes += plaintext.length;
      }
      this.chunks[chunkIndex] = plaintext;
    }

    const bps = this.meter.update(this.bytes);
    this.emitProgress(bps);
  }

  /** Finalize the current item into a Blob and push it to the completed list. */
  private async finalizeItem(): Promise<void> {
    if (!this.meta) throw new Error("file-complete before metadata");
    if (this.receivedChunks !== this.meta.totalChunks) {
      // Clean up a half-written disk file before failing.
      await this.abortSink();
      throw new Error(
        `Incomplete item "${this.meta.name}": got ${this.receivedChunks}/${this.meta.totalChunks} chunks`,
      );
    }

    if (this.streaming && this.sink) {
      // Streamed straight to disk: close the file; no in-memory blob.
      await this.sink.close();
      this.savedToDisk = this.sink.kind === "stream";
      this.completedItems.push({ blob: null, meta: this.meta, savedToDisk: this.savedToDisk });
      this.sink = null;
      this.streaming = false;
    } else {
      const parts = this.chunks.filter((c): c is Uint8Array => c !== undefined);
      const blob = new Blob(parts as BlobPart[], {
        type: this.meta.mime || "application/octet-stream",
      });
      this.completedItems.push({ blob, meta: this.meta });
    }
    // Reset per-item state.
    this.chunks = [];
    this.meta = null;
    this.receivedChunks = 0;
  }

  private async finalizeAll(): Promise<void> {
    if (this.completedItems.length !== this.totalItems) {
      await this.abortSink();
      throw new Error(
        `Incomplete transfer: got ${this.completedItems.length}/${this.totalItems} items`,
      );
    }
    this.done = true;
    this.rtc.sendControl({ kind: "ack" } satisfies ControlMessage);
    this.onComplete(this.completedItems);
  }

  /** Best-effort abort of an open streaming sink (cleans up a partial file). */
  private async abortSink(): Promise<void> {
    if (this.sink) {
      try {
        await this.sink.abort();
      } catch {
        /* ignore */
      }
      this.sink = null;
      this.streaming = false;
    }
  }

  private emitProgress(bps: number = this.meter.bytesPerSecond): void {
    const remaining = this.totalBytes - this.bytes;
    const eta = bps > 0 ? remaining / bps : Infinity;
    this.onProgress({
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      items: this.completedItems.length,
      totalItems: this.totalItems,
      currentName: this.meta?.name ?? "",
      bytesPerSecond: bps,
      etaSeconds: eta,
      fraction: this.totalBytes > 0 ? this.bytes / this.totalBytes : 0,
    });
  }
}
