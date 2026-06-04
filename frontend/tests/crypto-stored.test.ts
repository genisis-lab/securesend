import { describe, it, expect } from "vitest";
import {
  bytesToBase64Url,
  decryptChunk,
  deriveStoredAesKey,
  encryptChunk,
  generateIV,
  randomBytes,
} from "../src/lib/crypto";

/**
 * Covers the store-and-forward key path (deriveStoredAesKey), which derives an
 * AES-256-GCM key from ONLY the invite-link secret (+ optional passphrase),
 * with no live ECDH. The signaling/storage server never sees the link secret
 * (it lives in the URL fragment), so it can never derive this key.
 */
describe("deriveStoredAesKey (store-and-forward, no ECDH)", () => {
  it("same link secret + salt derive an interoperable key", async () => {
    const linkSecret = bytesToBase64Url(randomBytes(32));
    const salt = randomBytes(16);

    const senderKey = await deriveStoredAesKey(linkSecret, salt);
    const recipientKey = await deriveStoredAesKey(linkSecret, salt);

    const iv = generateIV();
    const aad = new Uint8Array();
    const msg = new TextEncoder().encode("stored-and-forwarded");
    const ct = await encryptChunk(senderKey, iv, msg, aad);
    const pt = await decryptChunk(recipientKey, iv, ct, aad);
    expect(new TextDecoder().decode(pt)).toBe("stored-and-forwarded");
  });

  it("a wrong link secret cannot decrypt", async () => {
    const salt = randomBytes(16);
    const senderKey = await deriveStoredAesKey(
      bytesToBase64Url(randomBytes(32)),
      salt,
    );
    const attackerKey = await deriveStoredAesKey(
      bytesToBase64Url(randomBytes(32)),
      salt,
    );

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(
      senderKey,
      iv,
      new TextEncoder().encode("secret"),
      aad,
    );
    await expect(decryptChunk(attackerKey, iv, ct, aad)).rejects.toBeTruthy();
  });

  it("a passphrase acts as a required second factor", async () => {
    const linkSecret = bytesToBase64Url(randomBytes(32));
    const salt = randomBytes(16);

    const withPass = await deriveStoredAesKey(linkSecret, salt, "hunter2");
    const rightPass = await deriveStoredAesKey(linkSecret, salt, "hunter2");
    const wrongPass = await deriveStoredAesKey(linkSecret, salt, "nope");

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(
      withPass,
      iv,
      new TextEncoder().encode("z"),
      aad,
    );
    expect(new TextDecoder().decode(await decryptChunk(rightPass, iv, ct, aad))).toBe(
      "z",
    );
    await expect(decryptChunk(wrongPass, iv, ct, aad)).rejects.toBeTruthy();
  });

  it("differing salts yield non-interoperable keys", async () => {
    const linkSecret = bytesToBase64Url(randomBytes(32));
    const senderKey = await deriveStoredAesKey(linkSecret, randomBytes(16));
    const recipientKey = await deriveStoredAesKey(linkSecret, randomBytes(16));

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(
      senderKey,
      iv,
      new TextEncoder().encode("x"),
      aad,
    );
    await expect(decryptChunk(recipientKey, iv, ct, aad)).rejects.toBeTruthy();
  });
});
