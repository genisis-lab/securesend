import { it, expect } from "vitest";
import { FileSender, FileReceiver } from "../src/lib/transfer";
import { uploadStored } from "../src/lib/store-transfer";
import { createHash, webcrypto } from "node:crypto";

const size = 4 * 1024 ** 3 + 123;
// A real 4 GiB byte stream generated one 64 KiB slice at a time; no giant allocation.
const file = {
  name: "four-gib.bin", size, type: "application/octet-stream",
  slice: (start: number, end: number) => ({ arrayBuffer: async () =>
    new Uint8Array(Math.min(end, size) - start).fill(37).buffer }),
} as unknown as File;
it.runIf(process.env.SECURESEND_LARGE_TESTS === "1")("streams 4 GiB + 123 bytes through live encryption and receiver without buffering the file", async () => {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as CryptoKey;
  let sender: FileSender;
  let written = 0;
  let done = false;
  const errors: string[] = [];
  const hash = createHash("sha256");
  const receiver = new FileReceiver({
    key,
    rtc: { sendControl: (m: unknown) => queueMicrotask(() => sender.handleControl(m as any)) } as any,
    onProgress: () => {}, onComplete: () => {}, onError: (e) => errors.push(e),
    openSink: async () => ({ kind: "stream", write: async (bytes) => { written += bytes.length; hash.update(bytes); }, close: async () => {}, abort: async () => {} }),
  });
  sender = new FileSender({ key, files: [file],
    rtc: { bufferedAmount: 0, sendBytes: (bytes: Uint8Array) => receiver.handleMessage(bytes.buffer as ArrayBuffer), sendControl: (m: unknown) => receiver.handleMessage(JSON.stringify(m)) } as any,
    onProgress: () => {}, onDone: () => { done = true; }, onError: (e) => errors.push(e),
  });
  await sender.send();
  const expected = createHash("sha256");
  const chunk = new Uint8Array(65536).fill(37);
  for (let offset = 0; offset < size; offset += chunk.length) expected.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
  expect(errors).toEqual([]);
  expect(done).toBe(true);
  expect(written).toBe(size);
  expect(hash.digest("hex")).toBe(expected.digest("hex"));
}, 180_000);

it.runIf(process.env.SECURESEND_LARGE_TESTS === "1")("uploads a 4 GiB + 123 byte encrypted stream in bounded multipart requests", async () => {
  const originalFetch = globalThis.fetch;
  let uploaded = 0;
  let parts = 0;
  let maxPart = 0;
  let completedSize = 0;
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input);
    if (init?.method === "PUT") {
      parts++;
      uploaded += init.body.byteLength;
      maxPart = Math.max(maxPart, init.body.byteLength);
      return new Response(JSON.stringify({ etag: `etag-${parts}` }));
    }
    if (url.includes("/complete")) {
      completedSize = JSON.parse(init.body).size;
      return new Response("{}");
    }
    if (url.includes("/meta")) return new Response(JSON.stringify({ expiresAt: Date.now() + 86400000 }));
    expect(new URL(url).searchParams.get("size")).toBe(String(size + Math.ceil(size / 65536) * 32));
    return new Response(JSON.stringify({ id: "integration-slot", token: "integration-token", partSize: 10 * 1024 * 1024 }), { status: 201 });
  }) as typeof fetch;
  try {
    await uploadStored({ files: [file], linkSecret: "integration-secret", salt: new Uint8Array(16), onProgress: () => {} });
    expect(uploaded).toBe(size + Math.ceil(size / 65536) * 32);
    expect(completedSize).toBe(uploaded);
    expect(parts).toBe(410);
    expect(maxPart).toBe(10 * 1024 * 1024);
  } finally { globalThis.fetch = originalFetch; }
}, 180_000);
