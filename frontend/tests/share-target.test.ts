import { describe, it, expect } from "vitest";
import { parseSharedContent } from "../src/lib/share-target";

describe("parseSharedContent", () => {
  it("returns null for a normal launch", () => {
    expect(parseSharedContent("")).toBeNull();
    expect(parseSharedContent("?source=pwa")).toBeNull();
    expect(parseSharedContent("?source=shortcut")).toBeNull();
  });

  it("extracts shared text", () => {
    expect(parseSharedContent("?text=hello%20world")).toEqual({
      text: "hello world",
    });
  });

  it("extracts a shared url", () => {
    expect(
      parseSharedContent("?url=https%3A%2F%2Fexample.com%2Fa"),
    ).toEqual({ text: "https://example.com/a" });
  });

  it("combines title, text, url and de-duplicates", () => {
    const search =
      "?title=My%20Note&text=Check%20this&url=https%3A%2F%2Fexample.com";
    expect(parseSharedContent(search)).toEqual({
      text: "My Note\nCheck this\nhttps://example.com",
    });
  });

  it("de-duplicates identical text and url", () => {
    const link = "https://example.com/x";
    const search = `?text=${encodeURIComponent(link)}&url=${encodeURIComponent(link)}`;
    expect(parseSharedContent(search)).toEqual({ text: link });
  });

  it("returns null when share params are present but empty", () => {
    expect(parseSharedContent("?text=&url=")).toBeNull();
    expect(parseSharedContent("?text=%20%20")).toBeNull();
  });
});
