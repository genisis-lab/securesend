import { describe, expect, it } from "vitest";
import { blobToBytes } from "../src/lib/chunker";
import { buildZipFile, exceedsZipLimits } from "../src/lib/download";

interface ZipEntryView {
  name: string;
  data: Uint8Array;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function parseStoredZip(bytes: Uint8Array): ZipEntryView[] {
  const entries: ZipEntryView[] = [];
  let offset = 0;
  while (readU32(bytes, offset) === 0x04034b50) {
    const method = readU16(bytes, offset + 8);
    const compressedSize = readU32(bytes, offset + 18);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.push({
      name,
      data: bytes.slice(dataStart, dataStart + compressedSize),
    });
    expect(method).toBe(0);
    offset = dataStart + compressedSize;
  }
  expect(readU32(bytes, offset)).toBe(0x02014b50);
  return entries;
}

describe("buildZipFile", () => {
  it("bundles multiple blobs into a portable ZIP with safe unique names", async () => {
    const zip = await buildZipFile(
      [
        { name: "../report.txt", blob: new Blob(["alpha"], { type: "text/plain" }) },
        { name: "report.txt", blob: new Blob(["beta"], { type: "text/plain" }) },
        { name: "photo.png", blob: new Blob([new Uint8Array([1, 2, 3])]) },
      ],
      "securesend-test.zip",
    );

    expect(zip.name).toBe("securesend-test.zip");
    expect(zip.type).toBe("application/zip");

    const entries = parseStoredZip(await blobToBytes(zip));
    expect(entries.map((entry) => entry.name)).toEqual([
      "report.txt",
      "report (1).txt",
      "photo.png",
    ]);
    expect(new TextDecoder().decode(entries[0].data)).toBe("alpha");
    expect(new TextDecoder().decode(entries[1].data)).toBe("beta");
    expect([...entries[2].data]).toEqual([1, 2, 3]);
  });
});

describe("exceedsZipLimits", () => {
  it("accepts ordinary bundles", () => {
    expect(exceedsZipLimits([1024, 2048, 4096])).toBe(false);
    expect(exceedsZipLimits([])).toBe(false);
  });

  it("rejects bundles whose total size would overflow 32-bit ZIP fields", () => {
    // 3 GiB + 2 GiB = 5 GiB > 4 GiB cap.
    expect(exceedsZipLimits([3 * 1024 ** 3, 2 * 1024 ** 3])).toBe(true);
  });

  it("rejects bundles with more than 65,535 entries", () => {
    expect(exceedsZipLimits(new Array(70000).fill(1))).toBe(true);
  });
});
