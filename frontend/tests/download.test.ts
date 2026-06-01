import { describe, it, expect } from "vitest";
import { buildFile, isImage, isVideo } from "../src/lib/download";

describe("media type detection", () => {
  it("recognizes image MIME types", () => {
    expect(isImage("image/jpeg")).toBe(true);
    expect(isImage("image/png")).toBe(true);
    expect(isImage("image/heic")).toBe(true);
    expect(isImage("IMAGE/WEBP")).toBe(true);
    expect(isImage("video/mp4")).toBe(false);
    expect(isImage("application/pdf")).toBe(false);
    expect(isImage("")).toBe(false);
  });

  it("recognizes video MIME types", () => {
    expect(isVideo("video/mp4")).toBe(true);
    expect(isVideo("video/quicktime")).toBe(true);
    expect(isVideo("image/png")).toBe(false);
    expect(isVideo("")).toBe(false);
  });
});

describe("buildFile", () => {
  it("wraps a blob with the given name and MIME", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const file = buildFile(blob, "pic.png", "image/png");
    expect(file.name).toBe("pic.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("falls back to octet-stream and a default name", () => {
    const blob = new Blob([new Uint8Array([0])]);
    const file = buildFile(blob, "", "");
    expect(file.name).toBe("download");
    expect(file.type).toBe("application/octet-stream");
  });
});
