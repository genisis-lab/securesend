import { describe, it, expect } from "vitest";
import { makeError, otherRole, clampTtl } from "../src/protocol";

describe("makeError", () => {
  it("produces a well-formed error envelope", () => {
    const parsed = JSON.parse(makeError("malformed-message"));
    expect(parsed).toEqual({ kind: "error", reason: "malformed-message" });
  });
});

describe("otherRole", () => {
  it("flips initiator <-> responder", () => {
    expect(otherRole("initiator")).toBe("responder");
    expect(otherRole("responder")).toBe("initiator");
  });
});

describe("clampTtl", () => {
  const FALLBACK = 600;
  const MIN = 60;
  const MAX = 24 * 60 * 60;

  it("uses the fallback when requested is null or non-finite", () => {
    expect(clampTtl(null, FALLBACK, MIN, MAX)).toBe(FALLBACK);
    expect(clampTtl(NaN, FALLBACK, MIN, MAX)).toBe(FALLBACK);
    expect(clampTtl(Infinity, FALLBACK, MIN, MAX)).toBe(FALLBACK);
  });

  it("clamps below MIN up to MIN", () => {
    expect(clampTtl(1, FALLBACK, MIN, MAX)).toBe(MIN);
    expect(clampTtl(0, FALLBACK, MIN, MAX)).toBe(MIN);
    expect(clampTtl(-5, FALLBACK, MIN, MAX)).toBe(MIN);
  });

  it("clamps above MAX down to MAX", () => {
    expect(clampTtl(MAX + 1, FALLBACK, MIN, MAX)).toBe(MAX);
    expect(clampTtl(999_999_999, FALLBACK, MIN, MAX)).toBe(MAX);
  });

  it("passes through valid values, flooring fractions", () => {
    expect(clampTtl(600, FALLBACK, MIN, MAX)).toBe(600);
    expect(clampTtl(123.9, FALLBACK, MIN, MAX)).toBe(123);
    expect(clampTtl(MAX, FALLBACK, MIN, MAX)).toBe(MAX);
    expect(clampTtl(MIN, FALLBACK, MIN, MAX)).toBe(MIN);
  });
});
