/**
 * Vitest setup.
 *
 * jsdom does not implement WebCrypto SubtleCrypto fully in all versions, so we
 * bind Node's `webcrypto` to globalThis.crypto. This gives the same Web Crypto
 * API surface the browser exposes, allowing us to test the real crypto code.
 */
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // @ts-expect-error - assigning Node webcrypto to the global
  globalThis.crypto = webcrypto;
}

// Tell React this is a valid environment for act(...) so component tests that
// render via react-dom/client don't emit "not configured to support act" warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
