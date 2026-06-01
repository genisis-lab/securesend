/** config.ts — runtime configuration sourced from Vite env vars. */

function fromEnv(key: string, fallback: string): string {
  const v = import.meta.env[key as keyof ImportMetaEnv];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export const SIGNAL_URL = fromEnv("VITE_SIGNAL_URL", "ws://localhost:8787");

export const APP_BASE_URL = fromEnv(
  "VITE_APP_BASE_URL",
  typeof location !== "undefined" ? location.origin : "http://localhost:5173",
);

/** Parse comma-separated ICE servers (from env) into RTCIceServer[]. */
export function getIceServers(): RTCIceServer[] {
  const raw = fromEnv("VITE_ICE_SERVERS", "stun:stun.l.google.com:19302");
  const servers: RTCIceServer[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry.startsWith("stun:")) {
      servers.push({ urls: entry });
    } else if (entry.startsWith("turn:") || entry.startsWith("turns:")) {
      // Format: turn:user:pass@host:port  (pass may itself be empty)
      const match = entry.match(/^(turns?):(?:([^:]+):([^@]+)@)?(.+)$/);
      if (match) {
        const [, scheme, user, pass, host] = match;
        const server: RTCIceServer = { urls: `${scheme}:${host}` };
        if (user) server.username = user;
        if (pass) server.credential = pass;
        servers.push(server);
      }
    }
  }
  return servers.length > 0
    ? servers
    : [{ urls: "stun:stun.l.google.com:19302" }];
}

/**
 * Fetch ICE servers (including short-lived TURN credentials) from the signaling
 * Worker's `/api/ice` endpoint. TURN dramatically improves connection success
 * for peers behind symmetric / carrier-grade NAT. Falls back to the static
 * env-var list (STUN) if the endpoint is unavailable.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const httpBase = SIGNAL_URL.replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  try {
    const res = await fetch(`${httpBase}/api/ice`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers;
      }
    }
  } catch {
    /* fall back to static config below */
  }
  return getIceServers();
}

/** Invite link expiry shown in the UI (mirrors backend ROOM_TTL_SECONDS). */
export const INVITE_TTL_SECONDS = 10 * 60;
