import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure logic + Web API (crypto, btoa) — Node provides these globally.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
