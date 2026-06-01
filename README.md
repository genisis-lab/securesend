# 🔐 SecureSend

**End-to-end encrypted, peer-to-peer file transfer as an installable PWA.**

> **🚀 Deploy your own**
> - App: Cloudflare Pages (e.g. `https://<your-app>.pages.dev`)
> - Signaling: Cloudflare Worker (e.g. `https://securesend-signal.<your-subdomain>.workers.dev`)
>
> See [Deployment](#deployment) for setup. Configure your own URLs via
> `frontend/.env.production` and the backend `wrangler.toml` / secrets.

Pick a file, generate an invite link, send it to a friend, and the file streams
**directly browser-to-browser** over a WebRTC DataChannel. The file is encrypted
in your browser with **AES-256-GCM** using a key derived via **ECDH + HKDF**, and
the bytes never touch a server. The Cloudflare backend exists **only** to relay
the connection handshake (WebRTC SDP/ICE + public ECDH keys).

```
┌──────────┐   public keys + SDP/ICE    ┌──────────────────┐   public keys + SDP/ICE   ┌──────────┐
│  Sender  │ ◀────────(signaling)──────▶ │ Cloudflare Worker │ ◀───────(signaling)──────▶ │ Receiver │
│ (browser)│                             │ + Durable Object  │                            │ (browser)│
└────┬─────┘                             └──────────────────┘                            └────┬─────┘
     │                                                                                        │
     │          encrypted file chunks (AES-256-GCM) over WebRTC DataChannel (P2P, DTLS)       │
     └────────────────────────────────────────────────────────────────────────────────────▶ │
```

The server never sees: the file, the filename/metadata plaintext, any private key,
the ECDH shared secret, or the derived AES key.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Encryption design](#encryption-design)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Local development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
  - [Backend → Cloudflare Workers](#backend--cloudflare-workers)
  - [Frontend → Cloudflare Pages](#frontend--cloudflare-pages)
- [Configuration / environment variables](#configuration--environment-variables)
- [Security notes](#security-notes)
- [Threat model](#threat-model)
- [Limitations](#limitations)
- [License](#license)

---

## Features

- 🔒 **True end-to-end encryption** — AES-256-GCM, key derived per-transfer via ECDH (P-256) + HKDF-SHA-256.
- 🛰️ **Server is a dumb pipe** — Cloudflare Worker + Durable Object relays handshake messages only.
- 📡 **Direct peer-to-peer** — file chunks travel over a WebRTC DataChannel (also DTLS-encrypted at the transport layer).
- 🧩 **Per-chunk random IV** and **authenticated metadata** (filename, size, MIME, chunk index) via AES-GCM AAD.
- 🔑 **Optional passphrase** mixed into key derivation (PBKDF2-SHA-256, 100k iterations) — never transmitted.
- ⏱️ **Configurable invite expiry** — sender picks from 5 min up to 24 h (default 10 min);
  the server clamps the value and reports the real expiry so the countdown is accurate.
  Rooms are auto-destroyed on expiry.
- 🤝 **Reliable completion handshake** — the receiver acks full receipt before the sender
  tears down, so the final chunk is never dropped.
- 🔌 **Resilient signaling** — the WebSocket auto-reconnects with backoff (and instantly when
  the tab returns to the foreground), so backgrounding the tab on mobile to share the link
  no longer drops the session.
- 🌐 **TURN-ready NAT traversal** — the Worker serves ICE servers (incl. optional short-lived
  Cloudflare TURN credentials) so peers behind symmetric/carrier-grade NAT can connect.
  TURN relays only encrypted bytes, preserving E2EE. Plus automatic **ICE restart** to
  recover transient network drops (Wi-Fi ↔ cellular).
- 📦 **Multiple files + text snippets** — send several files in one invite, or a text/clipboard
  snippet. Items stream sequentially over the same encrypted channel.
- ❌ **Cancel anytime** — abort an in-progress transfer (live or store upload); the peer/server is notified and partial uploads are aborted.
- 🔥 **Burn after download** (store mode) — optionally delete the stored encrypted copy the moment the recipient downloads it, for one-time retrieval.
- 🔁 **Resilient uploads** — store-mode part uploads retry with backoff on transient network errors, so a brief blip doesn't fail the whole transfer.
- ✅ **Delivery confirmation** — the sender sees "Delivered" once the receiver confirms receipt.
- 📱 **QR invite codes** — show a QR beside the link for easy desktop → phone transfers.
- 🛡️ **Per-IP rate limiting** — room creation is throttled by a token-bucket Durable Object to
  protect cost and availability. **Store-and-forward uploads have their own tighter budget**
  (6 new stored transfers/hour/IP) since each consumes real R2 storage.
- 🔐 **Origin-locked signaling** — the WebSocket upgrade enforces the `ALLOWED_ORIGINS`
  allow-list (CORS headers don't cover WS handshakes), so non-browser clients can't open rooms.
- 🚫 **Max 2 peers per room**; a third connection is rejected.
- 🔁 **Reconnect grace window** so a quick page refresh can rejoin.
- 📈 Live **progress, speed, ETA**, and a mutual **safety code** (shown on both peers) for out-of-band MITM verification.
- 📲 **PWA** with service worker + install prompt (Chromium one-tap install and iOS
  "Add to Home Screen" guidance); app shell cached, file data never cached.
- 🖼️ **Save to Photos on iOS** — received images/videos can be saved straight to the camera
  roll via the native share sheet (a plain download to Files is the fallback).
- 🔗 **Paste-a-link receiving** — recipients can paste an invite link into the app to start
  a download, in addition to tapping the link directly.

---

## Architecture

| Layer | Tech | Responsibility |
|------|------|----------------|
| Frontend | Vite + React + TypeScript | UI, crypto, WebRTC, chunking, PWA |
| Signaling | Cloudflare Workers + Durable Objects | WebSocket relay of SDP/ICE + public keys |
| Transport | WebRTC DataChannel | P2P delivery of encrypted chunks |
| Crypto | Web Crypto API | ECDH, HKDF, AES-GCM, PBKDF2, CSPRNG |

A **Durable Object** (`SignalingRoom`) is one ephemeral room. It coordinates exactly
two peers, relays opaque JSON messages between them, and self-destructs on a TTL alarm.

---

## Encryption design

The full flow is documented inline in [`frontend/src/lib/crypto.ts`](frontend/src/lib/crypto.ts).
Summary:

1. Each peer generates an **ephemeral ECDH key pair** (P-256) in the browser. The
   **private key is non-extractable** — Web Crypto will not let it be serialized out.
2. Each peer exports only its **public key (raw)** and sends it through signaling.
3. Each peer runs `ECDH(ourPrivate, peerPublic)` to compute the **same shared secret**.
   The server can't derive it because it never sees a private key (classic DH).
4. The shared secret is run through **HKDF-SHA-256** (with a public per-transfer salt)
   to derive a uniformly-random **AES-256-GCM** key.
5. If a **passphrase** is set, it is run through **PBKDF2-SHA-256** and folded into the
   key-derivation input, so the AES key also requires knowing the passphrase. The
   passphrase is never sent anywhere.
6. The file is read and encrypted **chunk-by-chunk** (default 64 KiB). Each chunk gets a
   **fresh random 12-byte IV**.
7. Per-chunk **AAD** authenticates `transferId | chunkIndex | totalChunks | size | mime | name`,
   so tampering with the chunk order or the bound metadata makes decryption fail.
8. Only encrypted frames cross the DataChannel. The receiver verifies + decrypts each
   chunk and reassembles the file.
9. Keys/buffers are dropped/zeroed when the transfer ends (best-effort in JS).

**The invite link contains the room ID *and a high-entropy link secret*, both placed in the
URL fragment** (`#/r/<roomId>/k/<linkSecret>`). Browsers never transmit the fragment to any
server, so the signaling relay sees neither. The link secret is mixed into the
key-derivation input keying material — this is what **defeats a man-in-the-middle by the
signaling server** (see below). The AES key is derived only after both peers exchange public
ECDH keys; it is never in the link.

### Defeating a signaling-relay MITM

A naive design where the server only relays public keys is vulnerable: a malicious relay
could substitute its own public key toward each peer, completing two separate ECDH
exchanges and transparently decrypting/re-encrypting. SecureSend closes this by folding the
**link secret** (32 bytes of CSPRNG entropy, carried only in the out-of-band invite-link
fragment) into the HKDF **input keying material** alongside the ECDH shared secret:

```
IKM = ECDH(ourPriv, peerPub)  ‖  linkSecret  ‖  PBKDF2(passphrase)?
key = HKDF-SHA256(IKM, salt, "securesend/v1/aes-256-gcm") -> AES-256-GCM
```

The relay never observes the URL fragment, so it cannot reconstruct the IKM. A MITM attempt
therefore yields a *different* key on the attacker's side, and authenticated AES-GCM
decryption simply **fails** rather than silently succeeding. The optional passphrase adds a
second independent secret.

As a belt-and-suspenders check, both peers also display an identical **safety code** (a Short
Authentication String): a SHA-256 fingerprint computed over *both* public keys in a canonical,
order-independent order. Because it covers both keys, a relay that substitutes either key
changes the code on at least one side, so a mismatch reveals the attack. Users can compare the
code out-of-band (e.g. read it aloud) for explicit verification.

### Wire format of an encrypted chunk

```
┌────────────┬──────────────┬─────────────────────────────┐
│  IV (12B)  │ chunkIndex   │  ciphertext (AES-GCM ct +    │
│            │ (4B uint32)  │  16B auth tag)               │
└────────────┴──────────────┴─────────────────────────────┘
```

---

## Project structure

```
securesend/
├── package.json                 # npm workspaces root (frontend + backend)
├── .env.example                 # env template (no secrets — only URLs)
├── .gitignore
├── README.md
│
├── backend/                     # Cloudflare Worker + Durable Object signaling
│   ├── wrangler.toml            # DO binding, vars (TTL, grace, origins)
│   ├── tsconfig.json
│   ├── test-integration.mjs     # live signaling integration smoke test
│   └── src/
│       ├── index.ts             # Worker entry: room creation + WS upgrade
│       ├── room.ts              # SignalingRoom Durable Object (relay + TTL)
│       └── protocol.ts          # shared signaling message shapes
│
└── frontend/                    # Vite + React + TS PWA
    ├── index.html               # CSP + app shell
    ├── vite.config.ts           # React + vite-plugin-pwa (manifest, workbox)
    ├── public/
    │   ├── _headers             # Cloudflare Pages security headers
    │   ├── _redirects           # SPA fallback
    │   └── icons/               # PWA icons (192, 512, 512-maskable)
    ├── scripts/generate-icons.mjs
    ├── tests/
    │   ├── crypto.test.ts        # ECDH/HKDF/AES-GCM/PBKDF2 unit tests
    │   ├── chunker.test.ts       # framing + full encrypt→decrypt pipeline
    │   └── setup.ts              # binds Node webcrypto for jsdom
    └── src/
        ├── main.tsx, App.tsx, styles.css
        ├── components/           # FileDropzone, InviteLink, Sender/Receiver, Progress
        ├── hooks/                # useTransferSession, useInstallPrompt
        └── lib/
            ├── crypto.ts         # ECDH + HKDF + AES-GCM core
            ├── chunker.ts        # chunking + frame pack/unpack + AAD
            ├── webrtc.ts         # RTCPeerConnection + DataChannel manager
            ├── signaling.ts      # WebSocket signaling client
            ├── transfer.ts       # FileSender / FileReceiver orchestration
            ├── session.ts        # end-to-end session state machine
            ├── config.ts         # env-driven runtime config
            └── format.ts         # bytes/speed/ETA formatting
```

---

## Prerequisites

- **Node.js ≥ 18**
- **npm** (uses npm workspaces)
- A **Cloudflare account** for deployment (free tier is fine). Durable Objects are
  available on the Workers free plan.
- `wrangler` is installed locally as a dev dependency (no global install required).

---

## Setup

```bash
git clone <your-repo-url> securesend
cd securesend

# Install all workspace dependencies (frontend + backend)
npm install

# Create your local frontend env file from the template
cp .env.example frontend/.env.local
```

Edit `frontend/.env.local` if your signaling server runs somewhere other than
`ws://localhost:8787` (the wrangler dev default).

---

## Local development

You need **two terminals**: one for the signaling Worker, one for the frontend.

**Terminal 1 — signaling backend (Cloudflare Worker, port 8787):**

```bash
npm run dev:signal
# (equivalently: npm run dev --workspace backend, which runs `wrangler dev`)
```

**Terminal 2 — frontend (Vite, port 5173):**

```bash
npm run dev
# (runs `vite` in the frontend workspace)
```

Open <http://localhost:5173>. To test a real transfer:

1. In one browser tab/window, pick a file and click **Create secure invite**.
2. Copy the invite link, open it in a **second tab or another browser/device**.
3. Watch the ECDH handshake complete and the encrypted transfer run.

> `localhost` is treated as a secure context, so Web Crypto and WebRTC work without HTTPS.
> For cross-device testing on a LAN you'll need HTTPS (use a tunnel like `cloudflared`
> or deploy).

**Optional:** verify the signaling server end-to-end while `wrangler dev` is running:

```bash
node backend/test-integration.mjs
```

This checks room creation, role assignment, peer-to-peer relay, and third-peer rejection.

---

## Testing

Unit tests cover the crypto utilities and chunk handling (run against Node's real
Web Crypto implementation):

```bash
npm test                       # runs vitest in the frontend workspace
npm run test:watch --workspace frontend   # watch mode
```

What's covered:

- Base64 / base64url round-trips
- IV length + uniqueness
- ECDH→HKDF shared-key agreement between two peers
- Salt separation (different salt ⇒ non-interoperable keys)
- Link-secret binding (wrong/unknown link secret ⇒ decryption fails — anti-MITM)
- Passphrase binding (wrong passphrase ⇒ decryption fails) and composition with the link secret
- AES-GCM AAD + ciphertext tamper detection
- Empty / large chunk round-trips
- Frame pack/unpack (incl. 32-bit chunk indices, too-short frames)
- Full pipeline: chunk a file → encrypt frames → decrypt out of order → reassemble
- **Sender↔receiver transfer**: multi-chunk delivery, the completion **ack** handshake, and a
  regression test proving the receiver never reports "incomplete" when the final chunk's
  async decryption resolves last

---

## Deployment

Deploy the **backend first**, note its URL, then build/deploy the **frontend** pointing at it.

### Backend → Cloudflare Workers

```bash
cd backend

# Authenticate wrangler with your Cloudflare account (one-time)
npx wrangler login

# Deploy the Worker + Durable Object
npm run deploy        # runs `wrangler deploy`
```

Wrangler prints a URL like `https://securesend-signal.<your-subdomain>.workers.dev`.
The WebSocket endpoint is the same host with the `wss://` scheme.

> **Free plan note:** Durable Objects on the Workers free plan must use a
> SQLite-backed migration. This repo's `wrangler.toml` already does that:
> ```toml
> [[migrations]]
> tag = "v1"
> new_sqlite_classes = ["SignalingRoom"]
> ```
> (Paid Workers plans may use `new_classes` instead.)

**Lock down origins for production** — edit `backend/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://<your-app>.pages.dev"   # your Pages origin(s), comma-separated
ROOM_TTL_SECONDS = "600"        # invite expiry (10 min)
RECONNECT_GRACE_SECONDS = "15"  # refresh grace window
```

Re-run `npm run deploy` after changing vars.

### Frontend → Cloudflare Pages

Set the production env vars so the app talks to your deployed Worker. Create
`frontend/.env.production` (or set them in the Pages dashboard build settings):

```dotenv
VITE_SIGNAL_URL=wss://securesend-signal.<your-subdomain>.workers.dev
VITE_APP_BASE_URL=https://<your-app>.pages.dev
VITE_ICE_SERVERS=stun:stun.l.google.com:19302
```

Build:

```bash
npm run build         # outputs frontend/dist
```

**Option A — Pages via Git integration (recommended):**

In the Cloudflare dashboard → Pages → *Create project* → connect your repo:

- **Build command:** `npm run build`
- **Build output directory:** `frontend/dist`
- **Root directory:** repository root (workspaces handle the rest)
- Add the `VITE_*` environment variables above under *Settings → Environment variables*.

**Option B — Direct upload with wrangler:**

```bash
npx wrangler pages deploy frontend/dist --project-name securesend
```

`public/_headers` (security headers incl. HSTS) and `public/_redirects` (SPA fallback)
are copied into `dist` and applied automatically by Pages.

> **TURN for restrictive networks:** plain STUN is enough for most NATs, but symmetric
> NATs/firewalls may need a TURN relay. Add it to `VITE_ICE_SERVERS`
> (e.g. `turn:user:pass@turn.example.com:3478`). TURN relays still only carry
> already-encrypted bytes — end-to-end encryption is preserved.

---

## Configuration / environment variables

All frontend config is via Vite env vars (see [`.env.example`](.env.example)). **None are secrets.**

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `VITE_SIGNAL_URL` | frontend | `ws://localhost:8787` | WebSocket base of the signaling Worker |
| `VITE_APP_BASE_URL` | frontend | `location.origin` | Base used to build invite links |
| `VITE_ICE_SERVERS` | frontend | Google STUN | Comma-separated STUN/TURN servers |
| `ALLOWED_ORIGINS` | backend (`wrangler.toml`) | `*` | Allowed CORS origins (set to your Pages origin in prod) |
| `ROOM_TTL_SECONDS` | backend | `600` | **Default/fallback** invite lifetime when the sender doesn't pick one |
| `RECONNECT_GRACE_SECONDS` | backend | `15` | Window to reclaim a role after a refresh |

---

## Security notes

- **No uploads, no server-side storage.** File bytes only travel over the P2P
  DataChannel. The Worker/DO never receive or persist them.
- **No keys on the server.** Private ECDH keys are non-extractable and stay in the
  browser. The shared secret and AES key are derived locally on each peer.
- **Invite links carry the room ID + a 32-byte link secret in the URL fragment** (`#/r/.../k/...`),
  which browsers never include in HTTP requests — so the signaling server sees neither. The
  link secret is folded into key derivation, which **defeats a MITM by the signaling relay**:
  an interceptor without the fragment derives a different key and decryption fails.
- **Per-chunk random IVs** via `crypto.getRandomValues()`. Room IDs use ~144 bits, and link
  secrets ~256 bits, of CSPRNG entropy.
- **Authenticated metadata.** Filename, size, MIME, total chunks, and chunk index are bound
  into each chunk's AES-GCM AAD; tampering breaks decryption.
- **Optional passphrase** (PBKDF2-SHA-256, 100k iterations) adds a second, independent secret
  on top of the link secret. It is shared out-of-band and never transmitted.
- **Anyone with the full link can join before it expires** — this is surfaced as a warning in
  the UI. Treat the link itself as the secret; share it over a trusted channel. Add a
  passphrase for defense-in-depth, and compare the displayed key **fingerprint** out-of-band
  for explicit verification.
- **HTTPS only.** The app refuses to operate meaningfully outside a secure context
  (required by Web Crypto + WebRTC). HSTS is set via `_headers`.
- **No sensitive logging.** Keys, filenames, and file metadata are never logged in production.
- **Best-effort memory hygiene.** Plaintext chunk buffers and salts are zeroed and key
  references dropped when a transfer ends. (JS/GC can't guarantee full erasure.)
- **Tight CSP** delivered BOTH as a response header (via `public/_headers`) and a meta tag.
  `script-src` and `style-src` are both `'self'` only — **no `'unsafe-inline'`** (the app uses
  zero inline `style=`/`script` attributes; the one dynamic style, the progress bar, is driven
  via a CSS custom property set through the CSSOM). Plus security headers
  (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, restrictive
  `Permissions-Policy`, COOP, HSTS).
- **Dependency hygiene.** `npm audit --omit=dev` reports **0 production vulnerabilities**
  (runtime deps: react, react-dom, qrcode). Remaining advisories are dev-only tooling
  (esbuild dev server, wrangler's bundled undici/ws) that never ship to the deployed app;
  they're slated for a dedicated Vite 8 / Wrangler 4 upgrade pass.
- **Abuse controls on the signaling/store backend.**
  - **Per-IP token-bucket rate limiting** (Durable Object). Room creation and
    store-and-forward uploads have *independent* budgets, so flooding one cannot starve the
    other. Store uploads are capped tighter (6/hour/IP) because each costs real R2 storage.
  - **Per-IP store byte budget** — beyond the request-count cap, total stored bytes per IP
    are capped in a rolling window (default **2 GiB / 24 h**), enforced at upload completion
    when the real size is known. Over-budget completions are rejected (`429`) and the
    multipart upload is aborted so nothing is persisted. Tunable via `STORE_BYTE_CAP` /
    `STORE_BYTE_WINDOW_MS`.
  - **Origin enforcement on the WebSocket upgrade.** CORS response headers do not apply to
    the WS handshake, so the upgrade request's `Origin` is checked against `ALLOWED_ORIGINS`
    directly; non-browser clients (no/disallowed Origin) are rejected with `403`.
  - **Shape validation** of room/store IDs and multipart part numbers guards against
    Durable-Object-name and path abuse.
  - **Store authorization**: uploads/complete/delete require the owner token; the token-less
    `/burn` endpoint works *only* for slots explicitly created with `burn=1`, so a stranger
    can't delete a normal transfer.

## Threat model

**Protected against:**

- A passive or active **signaling server** (or anyone who compromises it) reading file
  contents — it only ever sees public keys and SDP/ICE.
- A **store-and-forward server** reading stored files — R2 holds only client-side
  AES-256-GCM ciphertext; the decryption key lives in the invite-link fragment, which the
  server never receives. The server is **zero-knowledge** with respect to stored content.
- **On-path network observers** — app-layer AES-256-GCM plus WebRTC DTLS.
- **Tampering** with chunks, chunk ordering, or bound metadata — AES-GCM auth tag + AAD.
- **Link leakage after expiry** — rooms expire (10 min) and are destroyed; stored blobs
  auto-expire (default 24 h) and can be burned on first download.
- **Resource-exhaustion abuse** — per-IP token-bucket rate limiting (separate budgets for
  room creation vs. store uploads) and origin-locked WebSocket upgrades.

**Not fully protected against (mitigations):**

- A **malicious signaling relay performing a MITM** during the public-key exchange. This is
  mitigated by the **link secret** folded into key derivation: the relay never sees the URL
  fragment, so a substituted-key MITM produces a mismatched key and decryption fails. A
  passphrase and the out-of-band **fingerprint** add further defense.
- **Endpoint compromise** (malware/extension on either device) or **leaking the full invite
  link** to an attacker — out of scope; treat the link as a secret.
- **Traffic/metadata analysis** (that a transfer occurred, approximate size/timing).

## Limitations

- Requires a modern browser with **WebRTC** and **Web Crypto** (all current evergreen browsers).
- **Live** mode needs both peers **online simultaneously**. For asynchronous delivery, use
  the optional **Send for later** (store-and-forward) mode, where an encrypted copy is parked
  in R2 until the recipient downloads it.
- **Receiving very large files:** on desktop Chromium, single-file downloads **stream straight
  to disk** (via the File System Access API) for BOTH live P2P and store-and-forward, so size
  is effectively unbounded and the whole file never has to fit in memory. On other browsers
  (Firefox, Safari/iOS) and for multi-file transfers, the file is reassembled **in memory**
  before saving, so size is bounded by device memory.
- **Resilient downloads:** store-mode downloads (both streamed-to-disk and in-memory) resume
  automatically via HTTP Range if the connection drops mid-transfer, instead of restarting.
- Some **symmetric-NAT** networks require a TURN server (configured — see deployment notes).

---

## License

MIT. See `package.json`. Provided as-is; review the cryptographic design against your
own threat model before relying on it for sensitive data.
