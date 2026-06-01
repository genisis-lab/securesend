import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFileSink, canStreamToDisk } from "../src/lib/file-sink";

/**
 * Tests for the file sink. We can't exercise the real File System Access API in
 * jsdom, but we can (a) verify the in-memory fallback path and (b) verify that
 * a mocked showSaveFilePicker drives the streaming path and receives the bytes.
 */

describe("file-sink: memory fallback", () => {
  beforeEach(() => {
    // Ensure no streaming API present → memory sink.
    delete (window as any).showSaveFilePicker;
  });

  it("reports no streaming support", () => {
    expect(canStreamToDisk()).toBe(false);
  });

  it("collects chunks and triggers a download on close", async () => {
    const clicks: string[] = [];
    // Stub anchor click + object URL so downloadBlob doesn't touch real DOM nav.
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        (el as HTMLAnchorElement).click = () => clicks.push((el as HTMLAnchorElement).download);
      }
      return el;
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:mock",
      revokeObjectURL: () => {},
    });

    const sink = await createFileSink("hello.bin", "application/octet-stream");
    expect(sink.kind).toBe("memory");
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.write(new Uint8Array([4, 5]));
    await sink.close();

    expect(clicks).toContain("hello.bin");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe("file-sink: streaming path (mocked picker)", () => {
  afterEach(() => {
    delete (window as any).showSaveFilePicker;
    vi.restoreAllMocks();
  });

  it("streams chunks to the writable returned by showSaveFilePicker", async () => {
    const written: Uint8Array[] = [];
    let closed = false;
    (window as any).showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (d: Uint8Array) => {
          written.push(d.slice());
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    expect(canStreamToDisk()).toBe(true);
    const sink = await createFileSink("big.bin", "application/octet-stream");
    expect(sink.kind).toBe("stream");
    await sink.write(new Uint8Array([9, 9, 9]));
    await sink.write(new Uint8Array([8]));
    await sink.close();

    expect(closed).toBe(true);
    expect(written.length).toBe(2);
    expect(Array.from(written[0])).toEqual([9, 9, 9]);
    expect(Array.from(written[1])).toEqual([8]);
  });

  it("falls back to memory if the user cancels the picker", async () => {
    (window as any).showSaveFilePicker = async () => {
      throw new DOMException("user aborted", "AbortError");
    };
    const sink = await createFileSink("x.bin", "");
    expect(sink.kind).toBe("memory");
  });
});
