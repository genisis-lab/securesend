import { describe, it, expect } from "vitest";
import {
  buildChunkAAD,
  chunkCount,
  DEFAULT_CHUNK_SIZE,
  FileMetadata,
  GCM_TAG_BYTES,
  packFrame,
  readFileChunks,
  unpackFrame,
} from "../src/lib/chunker";
import {
  decryptChunk,
  deriveSharedAesKey,
  encryptChunk,
  exportPublicKey,
  generateEcdhKeyPair,
  generateIV,
  importPublicKey,
  IV_LENGTH,
  randomBytes,
} from "../src/lib/crypto";

const META: FileMetadata = {
  name: "secret.pdf",
  size: 1000,
  mime: "application/pdf",
  totalChunks: 4,
  chunkSize: 256,
  transferId: "abc123",
};

describe("chunkCount", () => {
  it("computes the correct number of chunks", () => {
    expect(chunkCount(0, 256)).toBe(0);
    expect(chunkCount(255, 256)).toBe(1);
    expect(chunkCount(256, 256)).toBe(1);
    expect(chunkCount(257, 256)).toBe(2);
    expect(chunkCount(1000, 256)).toBe(4);
  });
});

describe("AAD construction", () => {
  it("differs per chunk index", () => {
    const a = buildChunkAAD(META, 0);
    const b = buildChunkAAD(META, 1);
    expect(a).not.toEqual(b);
  });

  it("differs when metadata changes", () => {
    const a = buildChunkAAD(META, 0);
    const b = buildChunkAAD({ ...META, name: "other.pdf" }, 0);
    expect(a).not.toEqual(b);
  });
});

describe("frame pack/unpack", () => {
  it("round-trips iv, index, and ciphertext", () => {
    const iv = generateIV();
    const ct = randomBytes(100);
    const frame = packFrame(iv, 42, ct);
    expect(frame.length).toBe(IV_LENGTH + 4 + ct.length);

    const out = unpackFrame(frame);
    expect(out.iv).toEqual(iv);
    expect(out.chunkIndex).toBe(42);
    expect(out.ciphertext).toEqual(ct);
  });

  it("preserves large 32-bit chunk indices", () => {
    const frame = packFrame(generateIV(), 1_000_000, randomBytes(GCM_TAG_BYTES + 4));
    expect(unpackFrame(frame).chunkIndex).toBe(1_000_000);
  });

  it("rejects frames that are too short", () => {
    expect(() => unpackFrame(new Uint8Array(5))).toThrow();
  });
});

describe("readFileChunks", () => {
  it("yields all chunks in order with correct sizes", async () => {
    const total = 1000;
    const bytes = randomBytes(total);
    const blob = new Blob([bytes as BlobPart]);
    const chunkSize = 256;

    const collected: number[] = [];
    let reassembled = new Uint8Array(0);
    for await (const { index, data } of readFileChunks(blob, chunkSize)) {
      collected.push(index);
      const merged = new Uint8Array(reassembled.length + data.length);
      merged.set(reassembled);
      merged.set(data, reassembled.length);
      reassembled = merged;
    }
    expect(collected).toEqual([0, 1, 2, 3]);
    expect(reassembled).toEqual(bytes);
  });

  it("handles empty files", async () => {
    const blob = new Blob([]);
    const chunks = [];
    for await (const c of readFileChunks(blob)) chunks.push(c);
    expect(chunks.length).toBe(0);
  });

  it("uses the default chunk size constant", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(64 * 1024);
  });
});

describe("end-to-end: chunk a file, encrypt frames, decrypt, reassemble", () => {
  it("reassembles the original file via the full pipeline", async () => {
    // Derive a shared key between two peers.
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const salt = randomBytes(16);
    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(await exportPublicKey(bob.publicKey)),
      salt,
    );
    const bobKey = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(await exportPublicKey(alice.publicKey)),
      salt,
    );

    const original = randomBytes(5000);
    const blob = new Blob([original as BlobPart]);
    const chunkSize = 512;
    const meta: FileMetadata = {
      name: "data.bin",
      size: original.length,
      mime: "application/octet-stream",
      totalChunks: chunkCount(original.length, chunkSize),
      chunkSize,
      transferId: "t-1",
    };

    // Sender: encrypt + frame each chunk.
    const frames: Uint8Array[] = [];
    for await (const { index, data } of readFileChunks(blob, chunkSize)) {
      const iv = generateIV();
      const aad = buildChunkAAD(meta, index);
      const ct = await encryptChunk(aliceKey, iv, data, aad);
      frames.push(packFrame(iv, index, ct));
    }
    expect(frames.length).toBe(meta.totalChunks);

    // Receiver: unpack + decrypt + reassemble (in arbitrary order).
    const slots: (Uint8Array | undefined)[] = new Array(meta.totalChunks);
    for (const frame of frames.reverse()) {
      const { iv, chunkIndex, ciphertext } = unpackFrame(frame);
      const aad = buildChunkAAD(meta, chunkIndex);
      slots[chunkIndex] = await decryptChunk(bobKey, iv, ciphertext, aad);
    }

    const reassembled = new Uint8Array(
      slots.reduce((n, s) => n + (s?.length ?? 0), 0),
    );
    let offset = 0;
    for (const s of slots) {
      if (s) {
        reassembled.set(s, offset);
        offset += s.length;
      }
    }
    expect(reassembled).toEqual(original);
  });
});
