import { describe, expect, it } from "vitest";
import { defaultSignalUrl } from "../src/lib/config";

const PRODUCTION_SIGNAL_URL = "wss://securesend-signal.neil27.workers.dev";

describe("defaultSignalUrl", () => {
  it("uses the production Worker for the custom domain", () => {
    expect(defaultSignalUrl("send.builtwai.com")).toBe(PRODUCTION_SIGNAL_URL);
  });

  it("uses the production Worker for Pages production and preview hosts", () => {
    expect(defaultSignalUrl("securesend.pages.dev")).toBe(PRODUCTION_SIGNAL_URL);
    expect(defaultSignalUrl("preview.securesend.pages.dev")).toBe(
      PRODUCTION_SIGNAL_URL,
    );
  });

  it("keeps local development on the local Worker", () => {
    expect(defaultSignalUrl("localhost")).toBe("ws://localhost:8787");
    expect(defaultSignalUrl("127.0.0.1")).toBe("ws://localhost:8787");
  });
});
