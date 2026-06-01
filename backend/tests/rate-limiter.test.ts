import { describe, it, expect } from "vitest";
import { consumeToken, consumeBytes, BucketState, ByteBudgetState } from "../src/rate-limiter";

const CAP = 20;
const WINDOW = 10 * 60 * 1000; // 10 minutes

describe("consumeToken (token bucket)", () => {
  it("starts full: first request allowed with capacity-1 remaining", () => {
    const { result, next } = consumeToken(undefined, 1_000, CAP, WINDOW);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(CAP - 1);
    expect(next.tokens).toBeCloseTo(CAP - 1, 5);
  });

  it("allows exactly CAPACITY requests in a burst, then blocks", () => {
    let state: BucketState | undefined = undefined;
    const now = 5_000;
    let allowedCount = 0;
    for (let i = 0; i < CAP; i++) {
      const step = consumeToken(state, now, CAP, WINDOW);
      state = step.next;
      if (step.result.allowed) allowedCount++;
    }
    expect(allowedCount).toBe(CAP);

    // The next request in the same instant is blocked.
    const blocked = consumeToken(state, now, CAP, WINDOW);
    expect(blocked.result.allowed).toBe(false);
    expect(blocked.result.remaining).toBe(0);
    expect(blocked.result.retryAfter).toBeGreaterThan(0);
  });

  it("refills linearly over the window", () => {
    // Drain the bucket completely at t=0.
    let state: BucketState = { tokens: 0, ts: 0 };
    // After half the window, ~CAP/2 tokens should be available.
    const half = consumeToken(state, WINDOW / 2, CAP, WINDOW);
    expect(half.result.allowed).toBe(true);
    // Consumed one of the ~10 refilled; ~9 remain.
    expect(half.result.remaining).toBeGreaterThanOrEqual(8);
    expect(half.result.remaining).toBeLessThanOrEqual(10);
  });

  it("never exceeds capacity even after a long idle period", () => {
    const state: BucketState = { tokens: CAP, ts: 0 };
    const later = consumeToken(state, WINDOW * 100, CAP, WINDOW);
    // Refill is capped at CAPACITY; one consumed => CAP-1 remaining.
    expect(later.next.tokens).toBeLessThanOrEqual(CAP);
    expect(later.result.remaining).toBe(CAP - 1);
  });

  it("retryAfter is bounded by the refill cadence when empty", () => {
    const state: BucketState = { tokens: 0, ts: 0 };
    const blocked = consumeToken(state, 0, CAP, WINDOW);
    expect(blocked.result.allowed).toBe(false);
    // One token refills every WINDOW/CAP ms = 30s here.
    const perToken = WINDOW / CAP / 1000;
    expect(blocked.result.retryAfter).toBeLessThanOrEqual(Math.ceil(perToken));
    expect(blocked.result.retryAfter).toBeGreaterThan(0);
  });

  it("treats a clock that goes backwards as zero elapsed (no negative refill)", () => {
    const state: BucketState = { tokens: 5, ts: 10_000 };
    const earlier = consumeToken(state, 9_000, CAP, WINDOW);
    // tokens shouldn't increase from a backwards clock; one consumed from 5.
    expect(earlier.next.tokens).toBeCloseTo(4, 5);
    expect(earlier.result.allowed).toBe(true);
  });

  it("supports a tighter custom budget (store uploads: 6 / hour)", () => {
    const storeCap = 6;
    const storeWin = 60 * 60 * 1000;
    let state: BucketState | undefined = undefined;
    const now = 0;
    let allowed = 0;
    for (let i = 0; i < storeCap; i++) {
      const step = consumeToken(state, now, storeCap, storeWin);
      state = step.next;
      if (step.result.allowed) allowed++;
    }
    expect(allowed).toBe(storeCap);
    // 7th store upload in the same hour is blocked.
    const seventh = consumeToken(state, now, storeCap, storeWin);
    expect(seventh.result.allowed).toBe(false);
    // One token refills after window/cap = 10 minutes.
    expect(seventh.result.retryAfter).toBeLessThanOrEqual((storeWin / storeCap) / 1000);
  });
});

describe("consumeBytes (fixed-window byte budget)", () => {
  const CAP = 1000;
  const WIN = 24 * 60 * 60 * 1000;

  it("accumulates within the cap", () => {
    const a = consumeBytes(undefined, 0, 400, CAP, WIN);
    expect(a.result.allowed).toBe(true);
    expect(a.result.used).toBe(400);
    expect(a.result.remaining).toBe(600);

    const b = consumeBytes(a.next, 1000, 400, CAP, WIN);
    expect(b.result.allowed).toBe(true);
    expect(b.result.used).toBe(800);
  });

  it("rejects an addition that would exceed the cap, WITHOUT accumulating", () => {
    const a = consumeBytes(undefined, 0, 900, CAP, WIN);
    expect(a.result.allowed).toBe(true);
    const b = consumeBytes(a.next, 100, 200, CAP, WIN); // 900+200 > 1000
    expect(b.result.allowed).toBe(false);
    expect(b.next.used).toBe(900); // unchanged
    expect(b.result.remaining).toBe(100);
  });

  it("resets after the window elapses", () => {
    const a = consumeBytes(undefined, 0, 900, CAP, WIN);
    const afterWindow = consumeBytes(a.next, WIN + 1, 900, CAP, WIN);
    expect(afterWindow.result.allowed).toBe(true);
    expect(afterWindow.result.used).toBe(900); // fresh window
  });

  it("treats a single over-cap request as rejected", () => {
    const a = consumeBytes(undefined, 0, CAP + 1, CAP, WIN);
    expect(a.result.allowed).toBe(false);
    expect(a.next.used).toBe(0);
  });

  it("ignores non-positive / non-finite additions", () => {
    const a = consumeBytes(undefined, 0, -50, CAP, WIN);
    expect(a.result.allowed).toBe(true);
    expect(a.result.used).toBe(0);
    const b = consumeBytes(a.next, 0, NaN, CAP, WIN);
    expect(b.result.used).toBe(0);
  });

  it("reports resetMs counting down within the window", () => {
    const state: ByteBudgetState = { used: 100, windowStart: 0 };
    const r = consumeBytes(state, WIN / 2, 10, CAP, WIN);
    expect(r.result.resetMs).toBe(WIN / 2);
  });
});
