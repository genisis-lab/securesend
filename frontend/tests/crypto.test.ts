import { describe, it, expect } from "vitest";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  decryptChunk,
  deriveSharedAesKey,
  encryptChunk,
  exportPublicKey,
  generateEcdhKeyPair,
  generateIV,
  importPublicKey,
  IV_LENGTH,
  publicKeyFingerprint,
  pairFingerprint,
  randomBytes,
  wipe,
} from "../src/lib/crypto";

describe("base64 helpers", () => {
  it("round-trips standard base64", () => {
    const bytes = randomBytes(64);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips url-safe base64 without padding", () => {
    const bytes = randomBytes(50);
    const enc = bytesToBase64Url(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect(base64UrlToBytes(enc)).toEqual(bytes);
  });
});

describe("randomness", () => {
  it("produces an IV of the correct length", () => {
    expect(generateIV().length).toBe(IV_LENGTH);
  });

  it("produces distinct IVs", () => {
    const a = generateIV();
    const b = generateIV();
    expect(bytesToBase64(a)).not.toEqual(bytesToBase64(b));
  });
});

describe("ECDH + HKDF shared key derivation", () => {
  it("two peers derive identical AES keys and can talk", async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const salt = randomBytes(16);

    const aliceRaw = await exportPublicKey(alice.publicKey);
    const bobRaw = await exportPublicKey(bob.publicKey);

    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(bobRaw),
      salt,
    );
    const bobKey = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
    );

    // Prove the keys match by encrypting with one and decrypting with the other.
    const iv = generateIV();
    const aad = new TextEncoder().encode("meta");
    const msg = new TextEncoder().encode("hello secure world");
    const ct = await encryptChunk(aliceKey, iv, msg, aad);
    const pt = await decryptChunk(bobKey, iv, ct, aad);
    expect(new TextDecoder().decode(pt)).toBe("hello secure world");
  });

  it("different salts yield non-interoperable keys", async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const aliceRaw = await exportPublicKey(alice.publicKey);
    const bobRaw = await exportPublicKey(bob.publicKey);

    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(bobRaw),
      randomBytes(16),
    );
    const bobKey = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      randomBytes(16), // different salt
    );

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(aliceKey, iv, new TextEncoder().encode("x"), aad);
    await expect(decryptChunk(bobKey, iv, ct, aad)).rejects.toBeTruthy();
  });

  it("passphrase must match on both sides to derive the same key", async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const salt = randomBytes(16);
    const aliceRaw = await exportPublicKey(alice.publicKey);
    const bobRaw = await exportPublicKey(bob.publicKey);

    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(bobRaw),
      salt,
      "correct horse",
    );
    const bobWrong = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      "wrong passphrase",
    );
    const bobRight = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      "correct horse",
    );

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(aliceKey, iv, new TextEncoder().encode("secret"), aad);

    await expect(decryptChunk(bobWrong, iv, ct, aad)).rejects.toBeTruthy();
    const ok = await decryptChunk(bobRight, iv, ct, aad);
    expect(new TextDecoder().decode(ok)).toBe("secret");
  });

  it("link secret must match on both sides (defeats signaling MITM)", async () => {
    // Models a malicious relay that completed ECDH with each peer but never
    // saw the invite-link fragment. Without the matching link secret it cannot
    // derive the same AES key, so authenticated decryption fails.
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const salt = randomBytes(16);
    const aliceRaw = await exportPublicKey(alice.publicKey);
    const bobRaw = await exportPublicKey(bob.publicKey);

    const linkSecret = bytesToBase64Url(randomBytes(32));

    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(bobRaw),
      salt,
      undefined,
      linkSecret,
    );
    const bobRight = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      undefined,
      linkSecret,
    );
    const attacker = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      undefined,
      bytesToBase64Url(randomBytes(32)), // wrong / unknown link secret
    );

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(aliceKey, iv, new TextEncoder().encode("topsecret"), aad);

    const ok = await decryptChunk(bobRight, iv, ct, aad);
    expect(new TextDecoder().decode(ok)).toBe("topsecret");
    await expect(decryptChunk(attacker, iv, ct, aad)).rejects.toBeTruthy();
  });

  it("link secret and passphrase compose (both required)", async () => {
    const alice = await generateEcdhKeyPair();
    const bob = await generateEcdhKeyPair();
    const salt = randomBytes(16);
    const aliceRaw = await exportPublicKey(alice.publicKey);
    const bobRaw = await exportPublicKey(bob.publicKey);
    const linkSecret = bytesToBase64Url(randomBytes(32));

    const aliceKey = await deriveSharedAesKey(
      alice.privateKey,
      await importPublicKey(bobRaw),
      salt,
      "pass-1",
      linkSecret,
    );
    const bobRight = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      "pass-1",
      linkSecret,
    );
    // Correct link secret but wrong passphrase must still fail.
    const bobWrongPass = await deriveSharedAesKey(
      bob.privateKey,
      await importPublicKey(aliceRaw),
      salt,
      "pass-2",
      linkSecret,
    );

    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(aliceKey, iv, new TextEncoder().encode("z"), aad);
    expect(new TextDecoder().decode(await decryptChunk(bobRight, iv, ct, aad))).toBe("z");
    await expect(decryptChunk(bobWrongPass, iv, ct, aad)).rejects.toBeTruthy();
  });
});

describe("AES-GCM chunk encryption with AAD", () => {
  it("tampered AAD fails authentication", async () => {
    const pair = await generateEcdhKeyPair();
    const peer = await generateEcdhKeyPair();
    const salt = randomBytes(16);
    const key = await deriveSharedAesKey(
      pair.privateKey,
      await importPublicKey(await exportPublicKey(peer.publicKey)),
      salt,
    );

    const iv = generateIV();
    const data = randomBytes(128);
    const aad = new TextEncoder().encode("chunk:0");
    const ct = await encryptChunk(key, iv, data, aad);

    const wrongAad = new TextEncoder().encode("chunk:1");
    await expect(decryptChunk(key, iv, ct, wrongAad)).rejects.toBeTruthy();
  });

  it("tampered ciphertext fails authentication", async () => {
    const pair = await generateEcdhKeyPair();
    const peer = await generateEcdhKeyPair();
    const key = await deriveSharedAesKey(
      pair.privateKey,
      await importPublicKey(await exportPublicKey(peer.publicKey)),
      randomBytes(16),
    );
    const iv = generateIV();
    const aad = new Uint8Array();
    const ct = await encryptChunk(key, iv, randomBytes(64), aad);
    ct[0] ^= 0xff; // flip a bit
    await expect(decryptChunk(key, iv, ct, aad)).rejects.toBeTruthy();
  });

  it("round-trips empty and large chunks", async () => {
    const pair = await generateEcdhKeyPair();
    const peer = await generateEcdhKeyPair();
    const key = await deriveSharedAesKey(
      pair.privateKey,
      await importPublicKey(await exportPublicKey(peer.publicKey)),
      randomBytes(16),
    );
    const aad = new Uint8Array();

    for (const size of [0, 1, 65536]) {
      const iv = generateIV();
      const data = randomBytes(size);
      const ct = await encryptChunk(key, iv, data, aad);
      const pt = await decryptChunk(key, iv, ct, aad);
      expect(pt).toEqual(data);
    }
  });
});

describe("fingerprint + wipe", () => {
  it("fingerprint is stable and formatted", async () => {
    const raw = new Uint8Array(32).fill(7);
    const fp1 = await publicKeyFingerprint(raw);
    const fp2 = await publicKeyFingerprint(raw);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9A-F ]+$/);
  });

  it("pairFingerprint is order-independent (both peers match)", async () => {
    const a = randomBytes(65);
    const b = randomBytes(65);
    const fpAB = await pairFingerprint(a, b);
    const fpBA = await pairFingerprint(b, a);
    // Sender (ourKey=a, peerKey=b) and receiver (ourKey=b, peerKey=a) must agree.
    expect(fpAB).toBe(fpBA);
    expect(fpAB).toMatch(/^[0-9A-F ]+$/);
  });

  it("pairFingerprint changes if either key is substituted (MITM detection)", async () => {
    const a = randomBytes(65);
    const b = randomBytes(65);
    const mitm = randomBytes(65);
    const honest = await pairFingerprint(a, b);
    // A relay that swaps one side's key for its own yields a different SAS,
    // so the out-of-band comparison fails and the attack is revealed.
    const attacked = await pairFingerprint(a, mitm);
    expect(attacked).not.toBe(honest);
  });

  it("wipe zeroes buffers", () => {
    const a = randomBytes(16);
    wipe(a, undefined, null);
    expect(Array.from(a).every((b) => b === 0)).toBe(true);
  });
});
