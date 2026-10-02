import { describe, it, expect } from "vitest";
import { formatBytes } from "../src/lib/format";
describe("decimal file sizes", () => {
  it("matches the phone's GB units instead of showing 1.9 GB for a 2.05 GB file", () => {
    expect(formatBytes(2_050_000_000)).toBe("2.05 GB");
    expect(formatBytes(1_000_000)).toBe("1.00 MB");
    expect(formatBytes(999)).toBe("999 B");
  });
});
