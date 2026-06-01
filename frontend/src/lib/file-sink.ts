/**
 * file-sink.ts — a destination you write file chunks into, one at a time.
 *
 * A "sink" hides the browser differences in how we can persist a received file:
 *
 *   - Tier 1 (streaming to disk): the File System Access API
 *     (`showSaveFilePicker` → `FileSystemWritableFileStream`). Available on
 *     desktop Chromium (Chrome/Edge/Opera). Each decrypted chunk is written
 *     STRAIGHT TO DISK, so peak memory stays ~one chunk regardless of file
 *     size — true unbounded streaming. Requires a user gesture to pick a path.
 *
 *   - Tier 2 (in-memory fallback): collect chunks, then build a Blob and
 *     trigger a normal download. Used on Firefox, Safari/iOS, and anywhere
 *     Tier 1 is unavailable or the user dismissed the picker. Bounded by device
 *     memory, but works everywhere.
 *
 * Callers use one interface regardless of tier:
 *     const sink = await createFileSink(name, mime);
 *     await sink.write(chunk); …
 *     await sink.close();   // finalizes / triggers the download
 */

import { downloadBlob } from "./download";

export type SinkKind = "stream" | "memory";

export interface FileSink {
  /** How this sink persists data ("stream" = direct-to-disk). */
  readonly kind: SinkKind;
  /** Write the next plaintext chunk. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finalize: close the disk stream, or (memory) trigger the download. */
  close(): Promise<void>;
  /** Abort and clean up without saving (best effort). */
  abort(reason?: unknown): Promise<void>;
}

// --- File System Access API typings (not in older lib.dom) -----------------

interface FsWritable {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
interface FsFileHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FsWritable>;
}
type ShowSaveFilePicker = (opts?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FsFileHandle>;

function getShowSaveFilePicker(): ShowSaveFilePicker | null {
  const w = window as unknown as { showSaveFilePicker?: ShowSaveFilePicker };
  // Only available in secure contexts and NOT inside cross-origin iframes.
  return typeof w.showSaveFilePicker === "function" ? w.showSaveFilePicker : null;
}

/** Is direct streaming-to-disk available in this browser/context? */
export function canStreamToDisk(): boolean {
  return getShowSaveFilePicker() !== null;
}

/**
 * Create the best available file sink for `name`/`mime`.
 *
 * @param preferStream When true (default) and the File System Access API is
 *   available, prompts the user to choose a save location and streams to disk.
 *   MUST be called from a user gesture for the picker to open. If the user
 *   cancels the picker, we fall back to the in-memory sink.
 */
export async function createFileSink(
  name: string,
  mime: string,
  preferStream = true,
): Promise<FileSink> {
  const picker = preferStream ? getShowSaveFilePicker() : null;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name || "download",
        types: mime
          ? [{ description: "File", accept: { [mime]: suggestedExtensions(name) } }]
          : undefined,
      });
      const writable = await handle.createWritable();
      return new StreamFileSink(writable);
    } catch (err) {
      // AbortError = user dismissed the picker. Any other error → fall back.
      if (err instanceof DOMException && err.name === "AbortError") {
        // Respect the user's cancel by still giving them the in-memory option
        // (so the transfer isn't lost). Caller can decide to surface a button.
      }
      // Fall through to memory sink.
    }
  }
  return new MemoryFileSink(name, mime);
}

/** Derive a plausible extension list from a filename (for the picker filter). */
function suggestedExtensions(name: string): string[] {
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) return [name.slice(dot)];
  return [".bin"];
}

/** Tier 1: streams chunks directly to a file on disk. */
class StreamFileSink implements FileSink {
  readonly kind = "stream" as const;
  constructor(private writable: FsWritable) {}

  async write(chunk: Uint8Array): Promise<void> {
    // Copy into a concrete ArrayBuffer-backed view for the writable stream.
    const owned = new Uint8Array(chunk.length);
    owned.set(chunk);
    await this.writable.write(owned);
  }
  async close(): Promise<void> {
    await this.writable.close();
  }
  async abort(reason?: unknown): Promise<void> {
    try {
      if (this.writable.abort) await this.writable.abort(reason);
      else await this.writable.close();
    } catch {
      /* ignore */
    }
  }
}

/** Tier 2: buffers chunks in memory, then triggers a normal download. */
class MemoryFileSink implements FileSink {
  readonly kind = "memory" as const;
  private parts: Uint8Array[] = [];
  constructor(private name: string, private mime: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    // Copy so callers may reuse/zero their buffer after handing it to us.
    this.parts.push(chunk.slice());
  }
  async close(): Promise<void> {
    const blob = new Blob(this.parts as BlobPart[], {
      type: this.mime || "application/octet-stream",
    });
    this.parts = [];
    downloadBlob(blob, this.name);
  }
  async abort(): Promise<void> {
    this.parts = [];
  }
}
