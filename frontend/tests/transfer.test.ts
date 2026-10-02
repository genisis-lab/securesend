import { describe, it, expect, vi } from "vitest";
import { FileReceiver, FileSender, ReceivedItem } from "../src/lib/transfer";
import { blobToBytes } from "../src/lib/chunker";
import {
  deriveSharedAesKey,
  exportPublicKey,
  generateEcdhKeyPair,
  importPublicKey,
  randomBytes,
} from "../src/lib/crypto";

/**
 * A mock WebRtcManager that wires a sender and receiver together through an
 * in-process "channel". Messages are delivered asynchronously (ordered) so we
 * exercise the receiver's serial decryption queue — the original
 * "got N-1/N chunks" race.
 */
class MockChannel {
  senderInbound: ((d: ArrayBuffer | string) => void) | null = null;
  receiverInbound: ((d: ArrayBuffer | string) => void) | null = null;

  makeSenderRtc() {
    return {
      bufferedAmount: 0,
      dataChannel: { readyState: "open" },
      setBufferedAmountLowThreshold: () => {},
      sendBytes: (data: Uint8Array | ArrayBuffer) => {
        const buf =
          data instanceof Uint8Array ? data.slice().buffer : (data as ArrayBuffer).slice(0);
        queueMicrotask(() => this.receiverInbound?.(buf));
      },
      sendControl: (obj: unknown) => {
        const s = JSON.stringify(obj);
        queueMicrotask(() => this.receiverInbound?.(s));
      },
    } as any;
  }

  makeReceiverRtc() {
    return {
      sendControl: (obj: unknown) => {
        const s = JSON.stringify(obj);
        queueMicrotask(() => this.senderInbound?.(s));
      },
    } as any;
  }
}

async function sharedKeys() {
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  const salt = randomBytes(16);
  const aKey = await deriveSharedAesKey(
    a.privateKey,
    await importPublicKey(await exportPublicKey(b.publicKey)),
    salt,
  );
  const bKey = await deriveSharedAesKey(
    b.privateKey,
    await importPublicKey(await exportPublicKey(a.publicKey)),
    salt,
  );
  return { aKey, bKey };
}

/** Run a full sender->receiver transfer over the mock channel. */
async function runTransfer(
  files: File[],
  chunkSize: number,
): Promise<{ items: ReceivedItem[]; senderDone: boolean; error: string | null }> {
  const { aKey, bKey } = await sharedKeys();
  const channel = new MockChannel();
  let items: ReceivedItem[] = [];
  let error: string | null = null;
  let senderDone = false;

  const receiver = new FileReceiver({
    key: bKey,
    rtc: channel.makeReceiverRtc(),
    onProgress: () => {},
    onComplete: (received) => {
      items = received;
    },
    onError: (e) => {
      error = e;
    },
  });
  channel.receiverInbound = (d) => receiver.handleMessage(d);

  const sender = new FileSender({
    rtc: channel.makeSenderRtc(),
    key: aKey,
    files,
    chunkSize,
    onProgress: () => {},
    onDone: () => {
      senderDone = true;
    },
    onError: (e) => {
      error = e;
    },
  });
  channel.senderInbound = (d) => {
    if (typeof d === "string") sender.handleControl(JSON.parse(d));
  };

  await sender.send();
  return { items, senderDone, error };
}

describe("FileSender <-> FileReceiver end-to-end", () => {
  it("transfers a multi-chunk file and reassembles it exactly", async () => {
    const original = randomBytes(5000);
    const file = new File([original as BlobPart], "data.bin", {
      type: "application/octet-stream",
    });

    const { items, senderDone, error } = await runTransfer([file], 512);

    expect(error).toBeNull();
    expect(senderDone).toBe(true);
    expect(items.length).toBe(1);
    expect(items[0].meta.name).toBe("data.bin");
    expect(await blobToBytes(items[0].blob!)).toEqual(original);
  });

  it("does not report 'incomplete' when the final chunk decrypts last", async () => {
    const original = randomBytes(4096);
    const file = new File([original as BlobPart], "x.bin");
    const { items, error } = await runTransfer([file], 256);
    expect(error).toBeNull();
    expect(items.length).toBe(1);
    expect(await blobToBytes(items[0].blob!)).toEqual(original);
  });

  it("transfers MULTIPLE files in one session, each intact", async () => {
    const a = randomBytes(3000);
    const b = randomBytes(1500);
    const c = randomBytes(20);
    const files = [
      new File([a as BlobPart], "a.bin"),
      new File([b as BlobPart], "b.bin", { type: "application/octet-stream" }),
      new File([c as BlobPart], "c.txt", { type: "text/plain" }),
    ];

    const { items, senderDone, error } = await runTransfer(files, 512);

    expect(error).toBeNull();
    expect(senderDone).toBe(true);
    expect(items.map((i) => i.meta.name)).toEqual(["a.bin", "b.bin", "c.txt"]);
    expect(await blobToBytes(items[0].blob!)).toEqual(a);
    expect(await blobToBytes(items[1].blob!)).toEqual(b);
    expect(await blobToBytes(items[2].blob!)).toEqual(c);
    expect(items[2].meta.mime).toBe("text/plain");
  });

  it("sender receives an ack and only then resolves", async () => {
    const { aKey, bKey } = await sharedKeys();
    const channel = new MockChannel();
    const file = new File([randomBytes(1000) as BlobPart], "f.bin");

    let ackSeen = false;
    const receiver = new FileReceiver({
      key: bKey,
      rtc: channel.makeReceiverRtc(),
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    channel.receiverInbound = (d) => receiver.handleMessage(d);

    const sender = new FileSender({
      rtc: channel.makeSenderRtc(),
      key: aKey,
      files: [file],
      chunkSize: 300,
      onProgress: () => {},
      onDone: () => {},
      onError: () => {},
    });
    channel.senderInbound = (d) => {
      if (typeof d === "string") {
        const msg = JSON.parse(d);
        if (msg.kind === "ack") ackSeen = true;
        sender.handleControl(msg);
      }
    };

    await sender.send();
    expect(ackSeen).toBe(true);
  });
});


describe("large live transfer backpressure", () => {
  it("stops at one window until a slow disk finishes, then delivers exact bytes", async () => {
    const { aKey, bKey } = await sharedKeys();
    const channel = new MockChannel();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstWrite = true;
    let written = 0;
    let frames = 0;
    const errors: string[] = [];
    let completed = false;
    const receiver = new FileReceiver({
      key: bKey, rtc: channel.makeReceiverRtc(), onProgress: () => {},
      onComplete: (items) => { completed = items[0].savedToDisk === true; },
      onError: (e) => errors.push(e),
      openSink: async () => ({ kind: "stream", write: async (bytes) => {
        if (firstWrite) { firstWrite = false; await blocked; }
        expect(bytes.every((value) => value === 37)).toBe(true);
        written += bytes.length;
      }, close: async () => {}, abort: async () => {} }),
    });
    channel.receiverInbound = (data) => { if (typeof data !== "string") frames++; receiver.handleMessage(data); };
    const file = new File([new Uint8Array(3 * 1024 * 1024 + 7).fill(37)], "large.bin");
    const sender = new FileSender({ rtc: channel.makeSenderRtc(), key: aKey, files: [file], onProgress: () => {}, onDone: () => {}, onError: (e) => errors.push(e) });
    channel.senderInbound = (data) => sender.handleControl(JSON.parse(data as string));
    const sending = sender.send();
    await vi.waitFor(() => expect(frames).toBe(16));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toBe(16);
    expect(written).toBe(0);
    release();
    await sending;
    expect(errors).toEqual([]);
    expect(written).toBe(file.size);
    expect(completed).toBe(true);
  });
});

describe("live completion safety", () => {
  it("does not send file data when the receiver never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const sendBytes = vi.fn();
      const onDone = vi.fn();
      const onError = vi.fn();
      const sender = new FileSender({ key: {} as CryptoKey, files: [new File([], "empty")],
        rtc: { sendControl: () => {}, sendBytes, bufferedAmount: 0 } as any,
        onProgress: () => {}, onDone, onError });
      const task = sender.send();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await task;
      expect(sendBytes).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/save location/));
    } finally { vi.useRealTimers(); }
  });

  it("does not claim delivery when the final receiver acknowledgement is missing", async () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      const onError = vi.fn();
      let sender: FileSender;
      sender = new FileSender({ key: {} as CryptoKey, files: [new File([], "empty")],
        rtc: { sendControl: (msg: { kind: string }) => {
          if (msg.kind === "manifest") sender.handleControl({ kind: "receiver-ready" });
        }, bufferedAmount: 0 } as any,
        onProgress: () => {}, onDone, onError });
      const task = sender.send();
      await vi.advanceTimersByTimeAsync(30_000);
      await task;
      expect(onDone).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/did not confirm/));
    } finally { vi.useRealTimers(); }
  });
});

describe("disk-backed mobile receiving", () => {
  it("does not signal readiness or buffer a large file when storage setup fails", async () => {
    const { bKey } = await sharedKeys();
    const controls: any[] = [];
    const errors: string[] = [];
    const receiver = new FileReceiver({ key: bKey, rtc: { sendControl: (m: any) => controls.push(m) } as any,
      onProgress: () => {}, onComplete: () => {}, onError: e => errors.push(e),
      openSink: async () => { throw new Error("Not enough storage"); },
    });
    receiver.handleMessage(JSON.stringify({ kind: "manifest", totalItems: 1, totalBytes: 2_050_000_000,
      files: [{ name: "video.mp4", size: 2_050_000_000, mime: "video/mp4" }] }));
    await vi.waitFor(() => expect(errors).toEqual(["Not enough storage"]));
    expect(controls.map(m => m.kind)).toEqual(["nack"]);
  });
  it("retains a disk-backed file for explicit saving and cleans it only on Done", async () => {
    const { aKey, bKey } = await sharedKeys();
    const channel = new MockChannel();
    const dispose = vi.fn(async () => {});
    const diskFile = new File(["test"], "video.mp4");
    let items: ReceivedItem[] = [];
    const errors: string[] = [];
    const receiver = new FileReceiver({ key: bKey, rtc: channel.makeReceiverRtc(), onProgress: () => {},
      onComplete: result => { items = result; }, onError: e => errors.push(e),
      openSink: async () => ({ kind: "temporary", write: async () => {}, close: async () => {}, abort: async () => {}, getBlob: async () => diskFile, dispose }),
    });
    channel.receiverInbound = data => receiver.handleMessage(data);
    const sender = new FileSender({ key: aKey, files: [diskFile], rtc: channel.makeSenderRtc(), onProgress: () => {}, onDone: () => {}, onError: e => errors.push(e) });
    channel.senderInbound = data => sender.handleControl(JSON.parse(data as string));
    await sender.send();
    expect(errors).toEqual([]);
    expect(items[0].blob).toBe(diskFile);
    expect(items[0].diskBacked).toBe(true);
    expect(items[0].savedToDisk).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    await receiver.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
