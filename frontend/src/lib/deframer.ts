/**
 * deframer.ts — turn a byte STREAM into complete encrypted frames.
 *
 * Frames have the layout `[IV(12)][chunkIndex u32][ciphertext]` and NO explicit
 * length prefix. The ciphertext length is, however, deterministic: every chunk
 * is exactly `chunkSize` plaintext bytes except the last, and AES-GCM adds a
 * fixed 16-byte tag. So given the per-file plaintext sizes (from the manifest),
 * we know exactly how many bytes each frame occupies and can carve complete
 * frames out of an arbitrarily-chunked network stream — including frames that
 * straddle two network reads.
 *
 * `StreamDeframer` is fed `push(bytes)` repeatedly (in arrival order) and calls
 * `onFrame(frame)` for each complete frame, in order.
 */

import { IV_LENGTH } from "./crypto";
import { GCM_TAG_BYTES } from "./chunker";

const HEADER = IV_LENGTH + 4; // IV + uint32 chunkIndex

/** Total on-the-wire frame size for a chunk of `plainLen` plaintext bytes. */
export function frameSizeForPlain(plainLen: number): number {
  return HEADER + plainLen + GCM_TAG_BYTES;
}

/**
 * A schedule of expected frame sizes, in order. The deframer consumes exactly
 * this many bytes per frame. Build it from the manifest: for each file, each
 * chunk's plaintext length is min(chunkSize, remaining).
 */
export function buildFrameSchedule(
  files: { size: number; chunkSize: number; totalChunks: number }[],
): number[] {
  const sizes: number[] = [];
  for (const f of files) {
    for (let i = 0; i < f.totalChunks; i++) {
      const plainLen = Math.min(f.chunkSize, f.size - i * f.chunkSize);
      sizes.push(frameSizeForPlain(plainLen));
    }
  }
  return sizes;
}

export class StreamDeframer {
  /** Pending bytes not yet assembled into a complete frame. */
  private buf = new Uint8Array(0);
  /** Index into `schedule` of the frame we're currently accumulating. */
  private frameIdx = 0;
  /** Total bytes fed via push() so far (for Range-resume bookkeeping). */
  private pushed = 0;
  /** Set true if onFrame threw (e.g. a decryption failure). */
  private failedFlag = false;

  /**
   * @param schedule  Ordered list of exact frame byte-lengths (see
   *                  buildFrameSchedule).
   * @param onFrame   Called with each complete frame, in order. May be async;
   *                  push() awaits it so back-pressure propagates.
   */
  constructor(
    private schedule: number[],
    private onFrame: (frame: Uint8Array) => void | Promise<void>,
  ) {}

  /** Feed the next run of bytes from the stream. */
  async push(bytes: Uint8Array): Promise<void> {
    this.pushed += bytes.length;
    // Append to the pending buffer. Always copy into an owned ArrayBuffer-backed
    // array so types stay concrete and the source buffer can be reused.
    if (this.buf.length === 0) {
      const owned = new Uint8Array(bytes.length);
      owned.set(bytes);
      this.buf = owned;
    } else {
      const merged = new Uint8Array(this.buf.length + bytes.length);
      merged.set(this.buf, 0);
      merged.set(bytes, this.buf.length);
      this.buf = merged;
    }

    // Emit as many complete frames as the buffer now holds.
    while (this.frameIdx < this.schedule.length) {
      const need = this.schedule[this.frameIdx];
      if (this.buf.length < need) break;
      const frame = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      this.frameIdx += 1;
      try {
        await this.onFrame(frame);
      } catch (err) {
        this.failedFlag = true;
        throw err;
      }
    }
  }

  /** True once every scheduled frame has been emitted. */
  get done(): boolean {
    return this.frameIdx >= this.schedule.length;
  }

  /** Bytes left over after all scheduled frames (should be 0 on a clean stream). */
  get leftover(): number {
    return this.buf.length;
  }

  /**
   * Total bytes received so far. Used to RESUME a dropped download via an HTTP
   * `Range: bytes=<consumed>-` request — the server continues exactly where the
   * stream stopped, and the next pushed bytes line up with the pending buffer.
   */
  get consumed(): number {
    return this.pushed;
  }

  /** True if the onFrame callback threw (fatal; not a network blip). */
  get failed(): boolean {
    return this.failedFlag;
  }
}
