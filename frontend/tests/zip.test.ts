import { describe, it, expect } from "vitest";
import { buildZip, crc32 } from "../src/lib/zip";

const enc = new TextEncoder();

describe("crc32", () => {
  it("matches the known CRC-32 of 'hello'", () => {
    expect(crc32(enc.encode("hello"))).toBe(0x3610a686);
  });

  it("matches the known CRC-32 of 'The quick brown fox jumps over the lazy dog'", () => {
    expect(
      crc32(enc.encode("The quick brown fox jumps over the lazy dog")),
    ).toBe(0x414fa339);
  });

  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("buildZip", () => {
  it("produces a Blob tagged as application/zip", () => {
    const blob = buildZip([{ name: "a.txt", data: enc.encode("hi") }]);
    expect(blob.type).toBe("application/zip");
  });

  it("starts with the local file header signature (PK\\x03\\x04)", async () => {
    const blob = buildZip([{ name: "a.txt", data: enc.encode("hi") }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("ends with an EOCD record listing every entry", async () => {
    const blob = buildZip([
      { name: "a.txt", data: enc.encode("a") },
      { name: "b.txt", data: enc.encode("bb") },
      { name: "c.txt", data: enc.encode("ccc") },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const eocd = bytes.length - 22;
    // EOCD signature 0x06054b50, little-endian.
    expect(Array.from(bytes.slice(eocd, eocd + 4))).toEqual([
      0x50, 0x4b, 0x05, 0x06,
    ]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(eocd + 8, true)).toBe(3); // entries on this disk
    expect(view.getUint16(eocd + 10, true)).toBe(3); // total entries
  });

  it("embeds each file's name and stored bytes", async () => {
    const blob = buildZip([{ name: "hi.txt", data: enc.encode("hello") }]);
    const text = new TextDecoder().decode(
      new Uint8Array(await blob.arrayBuffer()),
    );
    expect(text).toContain("hi.txt");
    expect(text).toContain("hello");
  });

  it("creates a valid empty archive", async () => {
    const blob = buildZip([]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(22); // EOCD only
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });
});
