/**
 * crypto.ts — SecureSend encryption core.
 *
 * ============================================================================
 * ENCRYPTION FLOW (read this first)
 * ============================================================================
 * 1.  Each peer generates an *ephemeral* ECDH key pair (P-256) in the browser
 *     using Web Crypto. The private key never leaves the browser and is not
 *     exportable for transmission.
 * 2.  Each peer exports ONLY its public key (raw form) and sends it to the
 *     other peer through the signaling server. Public keys are safe to share.
 * 3.  Each peer imports the other's public key and runs ECDH to compute an
 *     identical shared secret. The server cannot derive this secret because it
 *     never sees either private key (classic Diffie-Hellman property).
 * 4.  The raw shared secret is NOT used directly as a key. We run it through
 *     HKDF-SHA-256 to derive a uniformly random AES-256-GCM key. HKDF also
 *     binds the key to a context string and an optional salt.
 * 5.  Optional passphrase: if the inviter sets a passphrase, we additionally
 *     fold a PBKDF2-derived value into the HKDF input keying material (IKM),
 *     so deriving the AES key also requires knowing the passphrase. This
 *     defends against a malicious party who obtains the invite link.
 * 6.  Files are encrypted chunk-by-chunk with AES-256-GCM. Every chunk uses a
 *     UNIQUE random 12-byte IV. Chunk metadata (index, total, filename, size,
 *     mime) is authenticated via AES-GCM Additional Authenticated Data (AAD)
 *     so it cannot be tampered with in transit.
 * 7.  Keys are zeroed/dropped from memory when the transfer completes.
 *
 * The signaling server only ever relays public keys + WebRTC handshake data.
 * It never receives a private key, the shared secret, or the AES key.
 * ============================================================================
 */

/** Named curve used for ECDH. P-256 is widely supported and fast. */
const ECDH_CURVE = "P-256";

/** AES-GCM standard nonce length in bytes (96 bits, recommended by NIST). */
export const IV_LENGTH = 12;

/** Context string baked into HKDF so derived keys are domain-separated. */
const HKDF_INFO_BASE = "securesend/v1/aes-256-gcm";

/**
 * PBKDF2 iteration count used when stretching an optional passphrase. Raised
 * from the original 100k to 600k to match current OWASP guidance for
 * PBKDF2-HMAC-SHA256.
 */
const PBKDF2_ITERATIONS = 600_000;

// ---------------------------------------------------------------------------
// Base64 helpers (URL-safe variants used for invite payloads).
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = b64url.length % 4 === 0 ? "" : "=".repeat(4 - (b64url.length % 4));
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return base64ToBytes(b64);
}

// ---------------------------------------------------------------------------
// Secure randomness.
// ---------------------------------------------------------------------------

/** Cryptographically secure random bytes via the platform CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Fresh random 96-bit IV for a single AES-GCM operation. */
export function generateIV(): Uint8Array {
  return randomBytes(IV_LENGTH);
}

// ---------------------------------------------------------------------------
// ECDH key pair generation + public key export/import.
// ---------------------------------------------------------------------------

export interface EcdhKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

/**
 * Generate an ephemeral ECDH key pair. `extractable` is true ONLY for the
 * public key path; the private key is generated extractable:false so it can
 * never be serialized out of the browser. We request both keys here and rely
 * on the fact that we only ever export the public one.
 */
export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: ECDH_CURVE },
    // Private key NOT extractable -> cannot be exported/sent anywhere.
    false,
    ["deriveKey", "deriveBits"],
  );
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Export our public key in raw form for transmission (safe to share). */
export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/** Import a peer's raw public key for use in ECDH derivation. */
export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "ECDH", namedCurve: ECDH_CURVE },
    true,
    [],
  );
}

// ---------------------------------------------------------------------------
// Shared-secret derivation -> HKDF -> AES-256-GCM key.
// ---------------------------------------------------------------------------

/**
 * Derive the shared AES-256-GCM key from our private key + peer public key.
 *
 * Steps:
 *   IKM  = ECDH(ourPriv, peerPub)  ‖  linkSecret?  ‖  PBKDF2(passphrase)?
 *   key  = HKDF-SHA256(IKM, salt, info) -> AES-256-GCM key
 *
 * SECURITY — defeating a malicious signaling relay (MITM):
 * A hostile signaling server could try a man-in-the-middle by substituting its
 * own public keys for each peer. To make that useless, we mix into the HKDF
 * *input keying material* two values the server NEVER sees:
 *   - `linkSecret`: a high-entropy token carried ONLY in the invite link's URL
 *     fragment. Browsers never transmit the fragment to any server, and the
 *     link is shared out-of-band, so the relay cannot know it.
 *   - `passphrase`: an optional human secret, stretched with PBKDF2.
 * Because these are folded into the IKM, the relay cannot derive the same AES
 * key even after completing ECDH with each peer — interception just causes
 * authenticated decryption to fail rather than silently succeed.
 *
 * @param salt        Random salt agreed by both peers (sent alongside pubkey).
 * @param passphrase  Optional passphrase, PBKDF2-stretched into the IKM.
 * @param linkSecret  Secret token from the invite link fragment (never sent
 *                    to the server). Binds the key to possession of the link.
 */
export async function deriveSharedAesKey(
  ourPrivate: CryptoKey,
  peerPublic: CryptoKey,
  salt: Uint8Array,
  passphrase?: string,
  linkSecret?: string,
): Promise<CryptoKey> {
  // 1. ECDH -> raw shared secret bits (256 bits for P-256).
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPublic },
      ourPrivate,
      256,
    ),
  );

  // 2. Assemble the HKDF input keying material. The ECDH secret is the base;
  //    the link secret and (stretched) passphrase are concatenated in so the
  //    final key depends on values the relay never observes.
  const ikmParts: Uint8Array[] = [sharedBits];
  if (linkSecret) {
    ikmParts.push(new TextEncoder().encode(linkSecret));
  }
  if (passphrase) {
    ikmParts.push(await stretchPassphrase(passphrase, salt));
  }
  const ikm = concatBytes(ikmParts);

  // 3. Import the combined IKM for HKDF.
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(ikm),
    "HKDF",
    false,
    ["deriveKey"],
  );

  // 4. Derive the AES-256-GCM key. Not extractable -> cannot be exported.
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(new TextEncoder().encode(HKDF_INFO_BASE)),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );

  // 5. Best-effort wipe of the intermediate secret material.
  sharedBits.fill(0);
  ikm.fill(0);

  return key;
}

/**
 * Derive an AES-256-GCM key from ONLY the link secret (+ optional passphrase),
 * with no ECDH. Used for STORE-AND-FORWARD transfers, where the recipient is
 * not online to perform a live key exchange.
 *
 * SECURITY: the link secret lives only in the invite link's URL fragment, which
 * browsers never send to a server. The ciphertext is uploaded to storage, but
 * the server never receives the link secret, so it cannot derive this key or
 * read the file. Anyone with the full link can decrypt — exactly the same trust
 * model the UI already communicates — and a passphrase adds a second factor.
 *
 *   IKM = linkSecret  ‖  PBKDF2(passphrase)?
 *   key = HKDF-SHA256(IKM, salt, info) -> AES-256-GCM
 *
 * @param linkSecret  High-entropy secret from the invite link fragment.
 * @param salt        Random per-transfer salt (public; stored with the blob).
 * @param passphrase  Optional passphrase, PBKDF2-stretched into the IKM.
 */
export async function deriveStoredAesKey(
  linkSecret: string,
  salt: Uint8Array,
  passphrase?: string,
): Promise<CryptoKey> {
  const ikmParts: Uint8Array[] = [new TextEncoder().encode(linkSecret)];
  if (passphrase) {
    ikmParts.push(await stretchPassphrase(passphrase, salt));
  }
  const ikm = concatBytes(ikmParts);

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(ikm),
    "HKDF",
    false,
    ["deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(new TextEncoder().encode(HKDF_INFO_BASE)),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  ikm.fill(0);
  return key;
}

/**
 * Stretch a low-entropy passphrase with PBKDF2-SHA256 (600k iterations) into
 * 256 bits of key material. The salt is the per-transfer HKDF salt.
 */
async function stretchPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const pbkdf2Key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: toArrayBuffer(salt),
        iterations: PBKDF2_ITERATIONS,
      },
      pbkdf2Key,
      256,
    ),
  );
}

/** Concatenate several byte arrays into one contiguous buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AES-GCM chunk encryption / decryption with authenticated metadata (AAD).
// ---------------------------------------------------------------------------

/**
 * Encrypt a single plaintext chunk.
 * @returns ciphertext (includes the GCM auth tag appended by Web Crypto).
 */
export async function encryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad), tagLength: 128 },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(ct);
}

/**
 * Decrypt a single chunk. Throws if the auth tag or AAD do not verify, which
 * guarantees both confidentiality and integrity of data + metadata.
 */
export async function decryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad), tagLength: 128 },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------------------
// Misc utilities.
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array view into a tightly-sized ArrayBuffer. Needed because
 * a Uint8Array may be a view over a larger buffer; Web Crypto wants the exact
 * bytes.
 */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer;
  }
  return view.slice().buffer;
}

/**
 * Compute a short SHA-256 fingerprint of a public key for an out-of-band
 * verification UX (peers can compare these to detect a MITM on signaling).
 * Returned as a grouped hex string, first 8 bytes.
 */
export async function publicKeyFingerprint(raw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(raw)));
  return formatFingerprint(digest);
}

/**
 * Compute a Short Authentication String over BOTH peers' public keys.
 *
 * This is the value users compare out-of-band to detect a man-in-the-middle on
 * signaling. For the comparison to work, BOTH peers must arrive at the SAME
 * string — so we hash the two raw public keys in a canonical, order-independent
 * order (sorted by their bytes). A relay that substitutes either public key
 * changes the SAS on at least one side, so a mismatch reveals the attack.
 *
 * (A per-key fingerprint can't serve this purpose: each peer would display a
 * different value with nothing to compare against.)
 */
export async function pairFingerprint(
  rawA: Uint8Array,
  rawB: Uint8Array,
): Promise<string> {
  const [first, second] = compareBytes(rawA, rawB) <= 0 ? [rawA, rawB] : [rawB, rawA];
  const combined = concatBytes([first, second]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(combined)));
  return formatFingerprint(digest);
}

/** Format the first 8 bytes of a digest as a grouped, upper-case hex string. */
function formatFingerprint(digest: Uint8Array): string {
  const hex = Array.from(digest.subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.replace(/(.{4})/g, "$1 ").trim().toUpperCase();
}

/** Lexicographic comparison of two byte arrays (returns <0, 0, or >0). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Best-effort wipe of sensitive byte buffers. JS can't guarantee memory is
 * cleared (GC, immutable strings), but zeroing buffers we control reduces the
 * window in which secrets sit in heap memory.
 */
export function wipe(...buffers: (Uint8Array | undefined | null)[]): void {
  for (const buf of buffers) {
    if (buf) buf.fill(0);
  }
}
