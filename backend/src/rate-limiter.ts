/**
 * RateLimiter Durable Object — a simple per-key token bucket.
 *
 * One instance per client IP (routed via idFromName(ip)). Protects the
 * unauthenticated `POST /api/rooms` endpoint from abuse that would otherwise
 * let anyone spin up unbounded Durable Objects (cost + availability risk).
 *
 * Algorithm: fixed-capacity bucket that refills linearly over a window. Each
 * allowed request consumes one token. When empty, requests are rejected with
 * the seconds until the next token is available.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens remaining after this request. */
  remaining: number;
  /** Seconds until the next token refills (when blocked). */
  retryAfter: number;
}

export interface BucketState {
  tokens: number;
  ts: number;
}

/** Fixed-window byte-budget state (separate from the token bucket). */
export interface ByteBudgetState {
  /** Bytes used in the current window. */
  used: number;
  /** Epoch-ms when the current window started. */
  windowStart: number;
}

export interface ByteBudgetResult {
  allowed: boolean;
  used: number;
  remaining: number;
  /** Ms until the window resets. */
  resetMs: number;
}

/**
 * Pure fixed-window byte accumulator. Adds `add` bytes to the per-window total
 * unless that would exceed `cap`; on rejection the total is left unchanged
 * (the caller should not store the over-budget payload). The window resets once
 * `windowMs` has elapsed since it started.
 */
export function consumeBytes(
  prev: ByteBudgetState | undefined,
  now: number,
  add: number,
  cap: number,
  windowMs: number,
): { next: ByteBudgetState; result: ByteBudgetResult } {
  let state = prev;
  if (!state || now - state.windowStart >= windowMs) {
    state = { used: 0, windowStart: now };
  }
  const sanitizedAdd = Number.isFinite(add) && add > 0 ? Math.floor(add) : 0;
  const wouldBe = state.used + sanitizedAdd;
  const resetMs = Math.max(0, state.windowStart + windowMs - now);

  if (wouldBe > cap) {
    return {
      next: state, // unchanged: reject without accumulating
      result: {
        allowed: false,
        used: state.used,
        remaining: Math.max(0, cap - state.used),
        resetMs,
      },
    };
  }
  const next: ByteBudgetState = { used: wouldBe, windowStart: state.windowStart };
  return {
    next,
    result: { allowed: true, used: next.used, remaining: Math.max(0, cap - next.used), resetMs },
  };
}

/**
 * Pure token-bucket step. Given the previous bucket state and the current
 * time, refill linearly and attempt to consume one token. Returned so the
 * algorithm can be unit-tested without a Durable Object or wall clock.
 */
export function consumeToken(
  prev: BucketState | undefined,
  now: number,
  capacity: number,
  refillMs: number,
): { next: BucketState; result: RateLimitResult } {
  const refillRate = capacity / refillMs; // tokens/ms
  const last = prev?.ts ?? now;
  let tokens = prev?.tokens ?? capacity;

  // Refill based on elapsed time (never exceed capacity, never go negative).
  tokens = Math.min(capacity, tokens + Math.max(0, now - last) * refillRate);

  let result: RateLimitResult;
  if (tokens >= 1) {
    tokens -= 1;
    result = { allowed: true, remaining: Math.floor(tokens), retryAfter: 0 };
  } else {
    const needed = 1 - tokens;
    result = {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(needed / refillRate / 1000),
    };
  }
  return { next: { tokens, ts: now }, result };
}

export class RateLimiter implements DurableObject {
  private state: DurableObjectState;

  /** Bucket capacity (max burst). */
  static readonly CAPACITY = 20;
  /** Full refill window in milliseconds (20 tokens / 10 min). */
  static readonly REFILL_MS = 10 * 60 * 1000;
  /** Default per-IP store byte budget: 2 GiB per 24h window. */
  static readonly DEFAULT_BYTE_CAP = 2 * 1024 * 1024 * 1024;
  static readonly DEFAULT_BYTE_WINDOW_MS = 24 * 60 * 60 * 1000;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    const url = new URL(request.url);

    // Byte-budget endpoint: POST /bytes?add=<n>&cap=<n>&win=<ms>
    // Accumulates bytes in a fixed window; rejects when the cap would be passed.
    if (url.pathname === "/bytes") {
      const add = clampInt(url.searchParams.get("add"), 0, 0, Number.MAX_SAFE_INTEGER);
      const cap = clampInt(
        url.searchParams.get("cap"),
        RateLimiter.DEFAULT_BYTE_CAP,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const win = clampInt(
        url.searchParams.get("win"),
        RateLimiter.DEFAULT_BYTE_WINDOW_MS,
        1_000,
        7 * 24 * 60 * 60 * 1000,
      );
      const stored = await this.state.storage.get<ByteBudgetState>("bytes");
      const { next, result } = consumeBytes(stored, now, add, cap, win);
      if (result.allowed) await this.state.storage.put("bytes", next);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Allow the caller to specify bucket params so different endpoints can have
    // independent budgets (e.g. cheap room creation vs. costly store uploads).
    // Defaults preserve the original room-creation behavior.
    const capacity = clampInt(
      url.searchParams.get("cap"),
      RateLimiter.CAPACITY,
      1,
      10_000,
    );
    const refillMs = clampInt(
      url.searchParams.get("win"),
      RateLimiter.REFILL_MS,
      1_000,
      24 * 60 * 60 * 1000,
    );
    const stored = await this.state.storage.get<BucketState>("bucket");
    const { next, result } = consumeToken(stored, now, capacity, refillMs);
    await this.state.storage.put("bucket", next);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** Parse + clamp an integer query param, falling back when absent/invalid. */
function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
