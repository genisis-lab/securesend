/**
 * SecureSend signaling Worker entry point.
 *
 * Responsibilities (and ONLY these):
 *   1. Generate fresh random room IDs (`POST /api/rooms`) — rate-limited per IP.
 *   2. Hand out short-lived ICE/TURN credentials (`GET /api/ice`) so peers
 *      behind strict/symmetric NATs can still connect. TURN only relays
 *      already-encrypted bytes, so end-to-end encryption is preserved.
 *   3. Upgrade `GET /api/rooms/:id/ws` requests to WebSocket and hand them to
 *      the matching SignalingRoom Durable Object.
 *
 * The Worker never touches file data, never sees encryption keys, and never
 * persists anything beyond ephemeral room coordination state in the DO.
 */

import { SignalingRoom } from "./room";
import { RateLimiter } from "./rate-limiter";
import type { RateLimitResult } from "./rate-limiter";
import { handleStore } from "./storage";

export { SignalingRoom, RateLimiter };

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  /** R2 bucket for optional store-and-forward (encrypted blobs only). */
  BLOBS?: R2Bucket;
  ALLOWED_ORIGINS: string;
  ROOM_TTL_SECONDS: string;
  RECONNECT_GRACE_SECONDS: string;
  /** Store-and-forward TTL. */
  STORE_TTL_SECONDS?: string;
  /** Per-IP store byte budget (bytes) and window (ms); optional overrides. */
  STORE_BYTE_CAP?: string;
  STORE_BYTE_WINDOW_MS?: string;
  /** Optional static TURN config (comma-separated urls + creds). */
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  /** Optional Cloudflare Calls TURN credentials (preferred). */
  TURN_TOKEN_ID?: string;
  TURN_API_TOKEN?: string;
  /** Comma-separated STUN urls (defaults to Google). */
  STUN_URLS?: string;
}

/** Room IDs: 18 random bytes -> base64url. ~144 bits of entropy, unguessable. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validate a room id has the expected shape (defensive, avoids DO name abuse). */
export function isValidRoomId(id: string): boolean {
  return /^[A-Za-z0-9_-]{16,48}$/.test(id);
}

export function corsHeaders(origin: string | null, allowed: string): HeadersInit {
  // When ALLOWED_ORIGINS is "*", echo any origin. Otherwise only allow listed.
  const list = allowed.split(",").map((s) => s.trim());
  let allowOrigin = "null";
  if (allowed.trim() === "*") {
    allowOrigin = origin ?? "*";
  } else if (origin && list.includes(origin)) {
    allowOrigin = origin;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Token, X-Manifest",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Is `origin` permitted by the ALLOWED_ORIGINS policy?
 *
 * CORS headers don't apply to the WebSocket handshake, so a non-browser client
 * could otherwise open `/api/rooms/:id/ws` directly. We enforce the same
 * origin allow-list on the upgrade request. A wildcard policy ("*", dev only)
 * permits everything, INCLUDING a missing Origin header; a locked-down policy
 * rejects both disallowed and absent origins.
 */
export function isOriginAllowed(origin: string | null, allowed: string): boolean {
  if (allowed.trim() === "*") return true;
  if (!origin) return false;
  return allowed
    .split(",")
    .map((s) => s.trim())
    .includes(origin);
}

/** Best-effort client IP for rate-limit bucketing. */
function clientKey(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "anonymous"
  );
}

/** Check the per-IP rate limit via the RateLimiter Durable Object. */
async function checkRateLimit(request: Request, env: Env): Promise<RateLimitResult> {
  return rateLimit(request, env, "rooms", null);
}

/**
 * Per-IP rate-limit check with an independent bucket per `scope`. Different
 * endpoints get separate budgets so a flood of one (e.g. costly R2 store
 * uploads) can't exhaust another (cheap room creation). `cap`/`win` override
 * the bucket capacity and refill window (ms); null uses the DO defaults.
 */
async function rateLimit(
  request: Request,
  env: Env,
  scope: string,
  opts: { cap: number; win: number } | null,
): Promise<RateLimitResult> {
  try {
    // Namespacing the DO id by scope gives each scope its own token bucket.
    const id = env.RATE_LIMITER.idFromName(`${scope}:${clientKey(request)}`);
    const stub = env.RATE_LIMITER.get(id);
    const qs = opts ? `?cap=${opts.cap}&win=${opts.win}` : "";
    const res = await stub.fetch("https://rl/consume" + qs);
    return (await res.json()) as RateLimitResult;
  } catch {
    // Fail open: never block legitimate users if the limiter errors.
    return { allowed: true, remaining: -1, retryAfter: 0 };
  }
}

/**
 * Store-upload budget: tighter than room creation because each slot consumes
 * real R2 storage + egress. 6 new stored transfers per hour per IP.
 */
const STORE_RL = { cap: 6, win: 60 * 60 * 1000 };

/**
 * Per-IP byte budget for stored transfers, charged at completion when the real
 * size is known. Defaults to the DO's 2 GiB / 24h; override via env.
 */
async function chargeStoreBytes(
  request: Request,
  env: Env,
  size: number,
): Promise<boolean> {
  try {
    const cap = parseInt(env.STORE_BYTE_CAP ?? "", 10);
    const win = parseInt(env.STORE_BYTE_WINDOW_MS ?? "", 10);
    const id = env.RATE_LIMITER.idFromName(`storebytes:${clientKey(request)}`);
    const stub = env.RATE_LIMITER.get(id);
    const params = new URLSearchParams({ add: String(Math.max(0, Math.floor(size))) });
    if (Number.isFinite(cap) && cap > 0) params.set("cap", String(cap));
    if (Number.isFinite(win) && win > 0) params.set("win", String(win));
    const res = await stub.fetch("https://rl/bytes?" + params.toString());
    const data = (await res.json()) as { allowed: boolean };
    return data.allowed;
  } catch {
    // Fail open: never block legitimate users if the limiter errors.
    return true;
  }
}

/** STUN servers (always safe to expose). */
function stunServers(env: Env): RTCIceServerLike[] {
  const raw = env.STUN_URLS || "stun:stun.l.google.com:19302";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
}

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Build the ICE server list. Prefers Cloudflare's TURN service (short-lived
 * credentials minted per request) when configured, else falls back to static
 * TURN env vars, else STUN-only.
 */
async function buildIceServers(env: Env): Promise<RTCIceServerLike[]> {
  const servers = stunServers(env);

  // 1. Cloudflare Calls TURN: mint short-lived credentials.
  if (env.TURN_TOKEN_ID && env.TURN_API_TOKEN) {
    try {
      const turnUrl =
        "https://rtc.live.cloudflare.com/v1/turn/keys/" +
        env.TURN_TOKEN_ID +
        "/credentials/generate";
      const resp = await fetch(turnUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          iceServers?: RTCIceServerLike | RTCIceServerLike[];
        };
        const ice = data.iceServers;
        if (Array.isArray(ice)) servers.push(...ice);
        else if (ice) servers.push(ice);
        return servers;
      }
    } catch {
      /* fall through to static / STUN */
    }
  }

  // 2. Static TURN credentials.
  if (env.TURN_URLS) {
    const urls = env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      servers.push({
        urls,
        username: env.TURN_USERNAME,
        credential: env.TURN_CREDENTIAL,
      });
    }
  }

  return servers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    // Pre-flight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ service: "securesend-signal", status: "ok" }),
        { headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    // ICE/TURN servers for the client's RTCPeerConnection.
    if (url.pathname === "/api/ice" && request.method === "GET") {
      const iceServers = await buildIceServers(env);
      return new Response(JSON.stringify({ iceServers }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ...cors,
        },
      });
    }

    // Create a new room: returns a fresh random room id. Rate-limited per IP.
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const rl = await checkRateLimit(request, env);
      if (!rl.allowed) {
        return new Response(
          JSON.stringify({ error: "rate-limited", retryAfter: rl.retryAfter }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(rl.retryAfter),
              ...cors,
            },
          },
        );
      }
      const roomId = generateRoomId();
      return new Response(JSON.stringify({ roomId }), {
        status: 201,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // Store-and-forward (optional, R2). Slot creation gets its own, tighter
    // per-IP budget (independent of room creation) because each stored blob
    // costs real R2 storage + egress.
    if (url.pathname.startsWith("/api/store")) {
      if (url.pathname === "/api/store" && request.method === "POST") {
        const rl = await rateLimit(request, env, "store", STORE_RL);
        if (!rl.allowed) {
          return new Response(
            JSON.stringify({ error: "rate-limited", retryAfter: rl.retryAfter }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retryAfter),
                ...cors,
              },
            },
          );
        }
      }
      const stored = await handleStore(request, env, cors, (size) =>
        chargeStoreBytes(request, env, size),
      );
      if (stored) return stored;
      // R2 not configured -> feature unavailable.
      return new Response(
        JSON.stringify({ error: "store-and-forward-unavailable" }),
        { status: 503, headers: { "Content-Type": "application/json", ...cors } },
      );
    }

    // WebSocket signaling endpoint: /api/rooms/:id/ws
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomId = decodeURIComponent(wsMatch[1]);
      if (!isValidRoomId(roomId)) {
        return new Response("Invalid room id", { status: 400, headers: cors });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", {
          status: 426,
          headers: cors,
        });
      }
      // CORS headers don't gate WebSocket handshakes, so enforce the origin
      // allow-list here to stop non-browser clients from opening rooms.
      if (!isOriginAllowed(origin, env.ALLOWED_ORIGINS)) {
        return new Response("Forbidden origin", { status: 403, headers: cors });
      }
      // Route to the Durable Object that owns this room id.
      const id = env.SIGNALING_ROOM.idFromName(roomId);
      const stub = env.SIGNALING_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};
