import { describe, it, expect } from "vitest";
import {
  StreamDeframer,
  buildFrameSchedule,
  frameSizeForPlain,
} from "../src/lib/deframer";
import { generateIV, randomBytes } from "../src/lib/crypto";
import { GCM_TAG_BYTES, packFrame as realPackFrame } from "../src/lib/chunker";

/**
 * The de-framer must reassemble complete frames from an arbitrarily-chunked
 * byte stream — including frames split across reads and multiple frames in one
 * read. We simulate "ciphertext" as plaintext + a fake 16-byte tag so the frame
 * sizes match the schedule (the deframer doesn't decrypt; it only carves bytes).
 */

// Build a frame whose ciphertext is `plainLen + GCM_TAG_BYTES` bytes.
function makeFrame(index: number, plainLen: number): Uint8Array {
  const fakeCiphertext = randomBytes(plainLen + GCM_TAG_BYTES);
  return realPackFrame(generateIV(), index, fakeCiphertext);
}

describe("frameSizeForPlain / buildFrameSchedule", () => {
  it("computes the on-wire size of a frame", () => {
    // IV(12) + index(4) + plain + tag(16)
    expect(frameSizeForPlain(100)).toBe(12 + 4 + 100 + 16);
    expect(frameSizeForPlain(0)).toBe(12 + 4 + 0 + 16);
  });

  it("builds a schedule honoring chunkSize and a smaller final chunk", () => {
    // size 1000, chunk 400 -> chunks of 400,400,200
    const sched = buildFrameSchedule([
      { size: 1000, chunkSize: 400, totalChunks: 3 },
    ]);
    expect(sched).toEqual([
      frameSizeForPlain(400),
      frameSizeForPlain(400),
      frameSizeForPlain(200),
    ]);
  });

  it("concatenates schedules across multiple files", () => {
    const sched = buildFrameSchedule([
      { size: 300, chunkSize: 256, totalChunks: 2 }, // 256, 44
      { size: 100, chunkSize: 256, totalChunks: 1 }, // 100
    ]);
    expect(sched).toEqual([
      frameSizeForPlain(256),
      frameSizeForPlain(44),
      frameSizeForPlain(100),
    ]);
  });
});

describe("StreamDeframer", () => {
  it("emits frames when fed the whole stream at once", async () => {
    const frames = [makeFrame(0, 256), makeFrame(1, 256), makeFrame(2, 50)];
    const schedule = frames.map((f) => f.length);
    const whole = concat(frames);

    const got: Uint8Array[] = [];
    const d = new StreamDeframer(schedule, (f) => {
      got.push(f.slice());
    });
    await d.push(whole);

    expect(d.done).toBe(true);
    expect(d.leftover).toBe(0);
    expect(got.length).toBe(3);
    got.forEach((g, i) => expect(g).toEqual(frames[i]));
  });

  it("reassembles frames split across many tiny reads", async () => {
    const frames = [makeFrame(0, 200), makeFrame(1, 200), makeFrame(2, 17)];
    const schedule = frames.map((f) => f.length);
    const whole = concat(frames);

    const got: Uint8Array[] = [];
    const d = new StreamDeframer(schedule, (f) => {
      got.push(f.slice());
    });

    // Feed 7 bytes at a time (frame boundaries never align with reads).
    for (let i = 0; i < whole.length; i += 7) {
      await d.push(whole.subarray(i, Math.min(i + 7, whole.length)));
    }

    expect(d.done).toBe(true);
    expect(d.leftover).toBe(0);
    got.forEach((g, i) => expect(g).toEqual(frames[i]));
  });

  it("handles multiple frames arriving in a single read", async () => {
    const frames = [makeFrame(0, 64), makeFrame(1, 64)];
    const schedule = frames.map((f) => f.length);
    const got: Uint8Array[] = [];
    const d = new StreamDeframer(schedule, (f) => {
      got.push(f.slice());
    });

    await d.push(concat(frames)); // both at once
    expect(got.length).toBe(2);
    expect(d.done).toBe(true);
  });

  it("does not emit a frame until it is fully buffered", async () => {
    const frame = makeFrame(0, 500);
    const got: Uint8Array[] = [];
    const d = new StreamDeframer([frame.length], (f) => {
      got.push(f.slice());
    });

    await d.push(frame.subarray(0, 100));
    expect(got.length).toBe(0); // incomplete
    expect(d.done).toBe(false);
    await d.push(frame.subarray(100));
    expect(got.length).toBe(1);
    expect(d.done).toBe(true);
  });

  it("tracks consumed bytes for Range-resume bookkeeping", async () => {
    const frames = [makeFrame(0, 100), makeFrame(1, 100)];
    const schedule = frames.map((f) => f.length);
    const whole = concat(frames);
    const d = new StreamDeframer(schedule, () => {});

    await d.push(whole.subarray(0, 30));
    expect(d.consumed).toBe(30);
    await d.push(whole.subarray(30));
    expect(d.consumed).toBe(whole.length);
    expect(d.done).toBe(true);
  });

  it("flags failure (and rethrows) when the frame callback throws", async () => {
    const frame = makeFrame(0, 64);
    const d = new StreamDeframer([frame.length], () => {
      throw new Error("decrypt failed");
    });
    await expect(d.push(frame)).rejects.toThrow("decrypt failed");
    expect(d.failed).toBe(true);
  });
});

function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
