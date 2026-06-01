import { describe, it, expect } from "vitest";
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
