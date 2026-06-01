import { describe, it, expect } from "vitest";
import {
  base64UrlEncode,
  generateRoomId,
  isValidRoomId,
  corsHeaders,
  isOriginAllowed,
} from "../src/index";

describe("base64UrlEncode", () => {
  it("uses URL-safe alphabet and strips padding", () => {
    // 0xFB 0xFF -> standard base64 "+/8=" ; url-safe "-_8"
    const out = base64UrlEncode(new Uint8Array([0xfb, 0xff]));
    expect(out).not.toMatch(/[+/=]/);
    expect(out).toBe("-_8");
  });

  it("round-trips to expected length for 18 bytes", () => {
    const out = base64UrlEncode(new Uint8Array(18));
    // 18 bytes -> 24 base64 chars, no padding.
    expect(out.length).toBe(24);
  });
});

describe("generateRoomId", () => {
  it("produces valid, unique-looking ids", () => {
    const a = generateRoomId();
    const b = generateRoomId();
    expect(isValidRoomId(a)).toBe(true);
    expect(isValidRoomId(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("isValidRoomId", () => {
  it("accepts the expected shape", () => {
    expect(isValidRoomId("A".repeat(16))).toBe(true);
    expect(isValidRoomId("aZ0_-".padEnd(24, "x"))).toBe(true);
  });

  it("rejects too-short, too-long, or illegal-char ids", () => {
    expect(isValidRoomId("short")).toBe(false);
    expect(isValidRoomId("A".repeat(49))).toBe(false);
    expect(isValidRoomId("has space".padEnd(20, "x"))).toBe(false);
    expect(isValidRoomId("path/traversal/attempt")).toBe(false);
    expect(isValidRoomId("../../etc")).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes any origin when ALLOWED_ORIGINS is *", () => {
    const h = corsHeaders("https://evil.test", "*") as Record<string, string>;
    expect(h["Access-Control-Allow-Origin"]).toBe("https://evil.test");
  });

  it("falls back to * when wildcard and no origin header", () => {
    const h = corsHeaders(null, "*") as Record<string, string>;
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("allows only listed origins otherwise", () => {
    const allowed = "https://example.pages.dev,https://staging.example.com";
    const ok = corsHeaders("https://example.pages.dev", allowed) as Record<string, string>;
    expect(ok["Access-Control-Allow-Origin"]).toBe("https://example.pages.dev");

    const second = corsHeaders("https://staging.example.com", allowed) as Record<string, string>;
    expect(second["Access-Control-Allow-Origin"]).toBe("https://staging.example.com");
  });

  it("returns 'null' origin for a disallowed origin", () => {
    const h = corsHeaders("https://evil.test", "https://example.pages.dev") as Record<string, string>;
    expect(h["Access-Control-Allow-Origin"]).toBe("null");
  });

  it("always sets Vary: Origin so caches don't leak CORS decisions", () => {
    const h = corsHeaders("https://example.pages.dev", "https://example.pages.dev") as Record<string, string>;
    expect(h["Vary"]).toBe("Origin");
  });
});

describe("isOriginAllowed (WebSocket upgrade gate)", () => {
  it("permits everything (incl. missing origin) under wildcard", () => {
    expect(isOriginAllowed("https://anything.test", "*")).toBe(true);
    expect(isOriginAllowed(null, "*")).toBe(true);
  });

  it("permits only listed origins under a locked-down policy", () => {
    const allowed = "https://example.pages.dev,https://staging.example.com";
    expect(isOriginAllowed("https://example.pages.dev", allowed)).toBe(true);
    expect(isOriginAllowed("https://staging.example.com", allowed)).toBe(true);
  });

  it("rejects disallowed and absent origins under a locked-down policy", () => {
    const allowed = "https://example.pages.dev";
    expect(isOriginAllowed("https://evil.test", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false); // non-browser client, no Origin
    expect(isOriginAllowed("", allowed)).toBe(false);
  });
});
