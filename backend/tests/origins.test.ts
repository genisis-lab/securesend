import { describe, it, expect } from "vitest";
import {
  normalizeOrigin,
  parseAllowedOrigins,
  corsHeaders,
  isOriginAllowed,
} from "../src/index";

describe("normalizeOrigin", () => {
  it("returns '' for null/undefined/empty input", () => {
    expect(normalizeOrigin(null)).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
    expect(normalizeOrigin("")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOrigin("  https://app.example.com  ")).toBe(
      "https://app.example.com",
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeOrigin("https://app.example.com/")).toBe(
      "https://app.example.com",
    );
    expect(normalizeOrigin("https://app.example.com///")).toBe(
      "https://app.example.com",
    );
  });

  it("leaves an already-normal origin untouched", () => {
    expect(normalizeOrigin("https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });
});

describe("parseAllowedOrigins", () => {
  it("recognizes the wildcard policy (with surrounding whitespace)", () => {
    expect(parseAllowedOrigins("*")).toEqual({ wildcard: true, list: [] });
    expect(parseAllowedOrigins("  *  ")).toEqual({ wildcard: true, list: [] });
  });

  it("splits, trims, and normalizes a comma-separated list", () => {
    const { wildcard, list } = parseAllowedOrigins(
      " https://a.example.com/ , https://b.example.com ",
    );
    expect(wildcard).toBe(false);
    expect(list).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("drops blank entries so a stray trailing comma can't widen the policy", () => {
    expect(parseAllowedOrigins("https://a.example.com,,").list).toEqual([
      "https://a.example.com",
    ]);
    expect(parseAllowedOrigins("").list).toEqual([]);
  });

  it("de-duplicates entries that normalize to the same origin", () => {
    expect(
      parseAllowedOrigins("https://a.example.com,https://a.example.com/").list,
    ).toEqual(["https://a.example.com"]);
  });
});

describe("trailing-slash tolerance + misconfig safety (regression)", () => {
  it("isOriginAllowed matches when the allow-list entry has a trailing slash", () => {
    // The browser Origin header never carries a trailing slash, but a
    // hand-edited env value frequently does. The two must still match.
    expect(
      isOriginAllowed("https://app.example.com", "https://app.example.com/"),
    ).toBe(true);
  });

  it("corsHeaders echoes the caller's exact origin despite a slash in the list", () => {
    const h = corsHeaders(
      "https://app.example.com",
      "https://app.example.com/",
    ) as Record<string, string>;
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
  });

  it("an empty (misconfigured) policy rejects every origin", () => {
    expect(isOriginAllowed("https://app.example.com", "")).toBe(false);
    const h = corsHeaders("https://app.example.com", "") as Record<
      string,
      string
    >;
    expect(h["Access-Control-Allow-Origin"]).toBe("null");
  });
});
