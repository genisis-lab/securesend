import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryFileSink } from "../src/lib/temporary-file-sink";
const info = { name: "movie.mp4", mime: "video/mp4", size: 2_050_000_000 };
afterEach(() => vi.unstubAllGlobals());
function storage(quota = 10_000_000_000) {
  const removeEntry = vi.fn(async () => {});
  const base = { keys: async function* () {}, removeEntry };
  vi.stubGlobal("navigator", { storage: {
    estimate: async () => ({ quota, usage: 0 }),
    getDirectory: async () => ({ getDirectoryHandle: async () => base }),
  } });
  return { removeEntry };
}
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  messages: any[] = [];
  constructor() { FakeWorker.last = this; }
  postMessage(message: any, transfer: Transferable[]) {
    this.messages.push({ ...message, transfer });
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result: message.command === "finish" ? new File(["data"], "movie.mp4") : undefined } }));
  }
}
describe("Safari temporary receive storage", () => {
  it("rejects insufficient space before starting a worker or buffering data", async () => {
    storage(1_000_000_000);
    const worker = vi.fn();
    vi.stubGlobal("Worker", worker);
    await expect(createTemporaryFileSink(info)).rejects.toThrow(/Not enough browser storage/);
    expect(worker).not.toHaveBeenCalled();
  });
  it("returns a disk file only after close and removes it on disposal", async () => {
    const { removeEntry } = storage();
    vi.stubGlobal("Worker", FakeWorker);
    const sink = await createTemporaryFileSink(info);
    expect(sink.kind).toBe("temporary");
    await expect(sink.getBlob!()).rejects.toThrow(/not ready/);
    const bytes = new Uint8Array([1, 2, 3]);
    await sink.write(bytes);
    const write = FakeWorker.last.messages[1];
    expect(write.transfer).toEqual([write.bytes]);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    await sink.close();
    expect((await sink.getBlob!()).size).toBe(4);
    expect(removeEntry).not.toHaveBeenCalled();
    await sink.dispose!();
    expect(removeEntry).toHaveBeenCalledTimes(1);
  });
  it("cleans up when the worker fails without falling back to memory", async () => {
    const { removeEntry } = storage();
    vi.stubGlobal("Worker", FakeWorker);
    const sink = await createTemporaryFileSink(info);
    FakeWorker.last.postMessage = () => {};
    const writing = sink.write(new Uint8Array([1]));
    FakeWorker.last.onerror!();
    await expect(writing).rejects.toThrow(/device storage/);
    await sink.abort();
    expect(removeEntry).toHaveBeenCalledTimes(1);
  });
});
