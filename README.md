# 🔐 SecureSend

**End-to-end encrypted browser file transfer as an installable PWA.**

> **🚀 Live demo:** [securesend.pages.dev](https://securesend.pages.dev)
>
> **Deploy your own:**
> - App: Cloudflare Pages (e.g. `https://<your-app>.pages.dev`)
> - Backend: Cloudflare Worker + Durable Objects (e.g. `https://securesend-signal.<your-subdomain>.workers.dev`)
> - Optional storage: Cloudflare R2 for encrypted “Send for later” transfers
>
> See [Deployment](#deployment) for setup. Configure your own URLs via
> `frontend/.env.production` and backend settings in `backend/wrangler.toml` / Wrangler secrets.

SecureSend lets you send files directly from one browser to another, with end-to-end encryption handled locally in the browser. It supports two transfer modes:

- **Live direct transfer:** both people are online at the same time and encrypted chunks move over a WebRTC DataChannel.
- **Send for later:** the sender uploads only client-side-encrypted ciphertext to Cloudflare R2, then the recipient downloads and decrypts it later. The server never receives the decryption key.

Files, filenames, metadata, and keys are encrypted client-side. The backend is used for signaling, rate limiting, optional TURN configuration, and optional encrypted blob storage — never plaintext file access.

```
Live mode:

┌──────────┐   public keys + SDP/ICE    ┌──────────────────┐   public keys + SDP/ICE   ┌──────────┐
│  Sender  │ ◀────────(signaling)──────▶ │ Cloudflare Worker │ ◀───────(signaling)──────▶ │ Receiver │
│ (browser)│                             │ + Durable Object  │                            │ (browser)│
└────┬─────┘                             └──────────────────┘                            └────┬─────┘
     │                                                                                        │
     │      encrypted file chunks (AES-256-GCM) over WebRTC DataChannel (P2P, DTLS)           │
     └──────────────────────────────────────────────────────────────────────────────────────▶ │

Send for later:

┌──────────┐       encrypted ciphertext + encrypted manifest       ┌──────────────┐
│  Sender  │ ────────────────────────────────────────────────────▶ │ Cloudflare R2 │
│ (browser)│                                                       │  ciphertext   │
└──────────┘                                                       └──────┬───────┘
                                                                          │
                                                                          ▼
                                                                    ┌──────────┐
                                                                    │ Receiver │
                                                                    │ decrypts │
                                                                    └──────────┘
```

The server never sees: plaintext files, plaintext filenames/metadata, private keys, the ECDH shared secret, the link secret, passphrases, or derived AES keys.

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

- 🔒 **True end-to-end encryption** — AES-256-GCM, with keys derived in-browser.
- 🛰️ **Live peer-to-peer mode** — encrypted file chunks travel over a WebRTC DataChannel; the Worker relays only SDP/ICE, public keys, and room messages.
- 📦 **Send for later** — asynchronous encrypted delivery through Cloudflare R2. The sender can close the tab after upload; the recipient downloads and decrypts later.
- 🧊 **Zero-knowledge storage** — R2 stores only ciphertext plus an encrypted manifest. The invite link fragment carries the secret needed to decrypt; fragments are not sent to the server.
- 🧩 **Multiple files + text snippets** — send several files in one invite, or turn a text/clipboard snippet into a downloadable `.txt` file.
- ⬇️ **Download all as ZIP** — recipients with 2+ received files get a single **Download all** button. Files are bundled locally into one ZIP with no server-side processing.
- 📱 **iPhone/iPad friendly saves** — uses the native share sheet where supported, so ZIP bundles and media can be saved cleanly from iOS/iPadOS.
- 🖼️ **Save media to Photos on iOS** — received images/videos can be sent to the native share sheet; normal file download remains the fallback.
- 🔥 **Burn after download** — optional one-time stored transfers delete their encrypted R2 copy only after the recipient confirms a successful save.
- 🔁 **Resilient uploads** — store-mode multipart uploads retry transient network failures with exponential backoff.
- 📥 **Resumable stored downloads** — store-mode downloads use HTTP Range resume so a network blip does not restart a large transfer from zero.
- 💾 **Streaming-to-disk for huge files** — on desktop Chromium, large single-file receives can stream decrypted bytes straight to disk via the File System Access API.
- ⏱️ **Configurable invite expiry** — sender-selectable expiry from 5 minutes to 24 hours; server clamps and reports the real expiry.
- ✅ **Reliable completion handshake** — receiver acknowledgement prevents the sender from tearing down before the final chunk is confirmed.
- 🔌 **Resilient signaling** — WebSocket reconnects with backoff and on foregrounding, improving mobile/background-tab reliability.
- 🌐 **TURN-ready NAT traversal** — the Worker can serve ICE servers and optional short-lived TURN credentials for restrictive networks. TURN relays only already-encrypted bytes.
- ❌ **Cancel anytime** — abort live transfers or store uploads; peers/server are notified and partial uploads are cleaned up.
- ✅ **Delivery confirmation** — sender sees “Delivered” once the receiver confirms receipt.
- 📱 **QR invite codes** — show a QR code for desktop → phone transfers.
- 🛡️ **Rate limiting and byte budgets** — separate per-IP budgets for room creation and stored uploads protect availability and R2 cost.
- 🔐 **Origin-locked signaling** — WebSocket upgrades enforce `ALLOWED_ORIGINS` directly.
- 🚫 **Max 2 peers per room**; third connections are rejected.
- 🔁 **Reconnect grace window** for quick refresh/rejoin.
- 📈 Live **progress, speed, ETA**, and a mutual **safety code** for out-of-band MITM verification.
- 📲 **Installable PWA** with service worker, app shell caching, install prompt, and iOS “Add to Home Screen” guidance. File data is never cached by the app shell.
- 🔗 **Paste-a-link receiving** — recipients can paste an invite link into the app instead of opening it directly.

---

## Architecture

| Layer | Tech | Responsibility |
|------|------|----------------|
| Frontend | Vite + React + TypeScript | UI, crypto, WebRTC, chunking, ZIP bundling, PWA |
| Signaling | Cloudflare Workers + Durable Objects | WebSocket relay of SDP/ICE + public keys, room TTL, reconnects |
| Optional storage | Cloudflare R2 | Stores only client-side-encrypted ciphertext for Send for later |
| Abuse controls | Durable Objects | Per-IP room/store rate limiting and store byte budgets |
| Transport | WebRTC DataChannel | Live P2P delivery of encrypted chunks |
| Crypto | Web Crypto API | ECDH, HKDF, AES-GCM, PBKDF2, CSPRNG |

A **Durable Object** (`SignalingRoom`) is one ephemeral live transfer room. It coordinates exactly two peers, relays opaque JSON messages between them, and self-destructs on a TTL alarm.

For **Send for later**, the browser encrypts file chunks and an encrypted manifest locally, then uploads ciphertext to R2 through the Worker. The recipient fetches the encrypted manifest/blob and decrypts in-browser with the secret from the invite link fragment.

---

## Encryption design

The full live-mode flow is documented inline in [`frontend/src/lib/crypto.ts`](frontend/src/lib/crypto.ts).

1. Each live peer generates an **ephemeral ECDH key pair** (P-256) in the browser. The private key is non-extractable.
2. Peers exchange only public keys through signaling.
3. Each peer runs `ECDH(ourPrivate, peerPublic)` to compute the same shared secret.
4. The shared secret is run through **HKDF-SHA-256** with a public transfer salt to derive an **AES-256-GCM** key.
5. If a passphrase is set, it is run through **PBKDF2-SHA-256** and folded into key derivation. The passphrase is never transmitted.
6. Files are encrypted chunk-by-chunk. Each chunk gets a fresh random 12-byte IV.
7. Per-chunk **AAD** authenticates `transferId | chunkIndex | totalChunks | size | mime | name`, so tampering with order or metadata makes decryption fail.
8. Only encrypted frames cross the network.

**The invite link contains the room/storage ID and a high-entropy link secret in the URL fragment** (`#/r/<roomId>/k/<linkSecret>` or the stored-transfer equivalent). Browsers never transmit fragments to servers, so the backend does not receive the link secret.

### Send for later keying

Store mode does not rely on ECDH because the recipient may be offline when the sender uploads. Instead, the stored-transfer AES key is derived from the invite link secret, a random salt, and optional passphrase. R2 receives only ciphertext and an encrypted manifest.

### Defeating a signaling-relay MITM

A naive relay-only ECDH design is vulnerable to key substitution by a malicious signaling relay. SecureSend folds the **link secret** into HKDF input alongside the ECDH shared secret:

```
IKM = ECDH(ourPriv, peerPub)  ‖  linkSecret  ‖  PBKDF2(passphrase)?
key = HKDF-SHA256(IKM, salt, "securesend/v1/aes-256-gcm") -> AES-256-GCM
```

The relay never observes the URL fragment, so it cannot reconstruct the IKM. A substituted-key MITM derives a different key and authenticated AES-GCM decryption fails.

Both peers also display a matching **safety code**: a SHA-256 fingerprint over both public keys in canonical order. Users can compare it out-of-band for explicit verification.

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
├── README.md
│
├── backend/                     # Cloudflare Worker backend
│   ├── wrangler.toml            # DO bindings, R2 binding, vars, origins
│   ├── test-integration.mjs     # live signaling smoke test
│   └── src/
│       ├── index.ts             # Worker entry: rooms, WS upgrade, ICE, store API
│       ├── room.ts              # SignalingRoom Durable Object
│       ├── rate-limit.ts        # per-IP token/byte budgets
│       ├── storage.ts           # R2 store-and-forward API + Range support
│       └── protocol.ts          # shared signaling message shapes
│
└── frontend/                    # Vite + React + TS PWA
    ├── index.html               # CSP + app shell
    ├── vite.config.ts           # React + vite-plugin-pwa
    ├── public/                  # Cloudflare Pages headers, redirects, icons
    ├── scripts/check-pwa.mjs    # production PWA sanity check
    ├── tests/                   # crypto/chunker/transfer/store tests
    └── src/
        ├── main.tsx, App.tsx, styles.css
        ├── components/          # sender/receiver/progress/install UI
        ├── hooks/               # session/install hooks
        └── lib/
            ├── crypto.ts        # ECDH + HKDF + AES-GCM core
            ├── chunker.ts       # chunking + frame pack/unpack + AAD
            ├── transfer.ts      # live transfer orchestration
            ├── store-transfer.ts# encrypted R2 upload/download/resume
            ├── download.ts      # share sheet, file downloads, ZIP bundle
            ├── zip.ts           # tiny dependency-free ZIP writer
            ├── file-sink.ts     # streaming-to-disk support
            ├── signaling.ts     # WebSocket signaling client
            ├── webrtc.ts        # RTCPeerConnection + DataChannel manager
            ├── session.ts       # end-to-end session state machine
            ├── config.ts        # env-driven runtime config
            └── format.ts        # bytes/speed/ETA formatting
```

---

## Prerequisites

- **Node.js ≥ 18**
- **npm** (uses npm workspaces)
- A **Cloudflare account** for deployment
- `wrangler` is installed locally as a dev dependency (no global install required)

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

Edit `frontend/.env.local` if your signaling server runs somewhere other than `ws://localhost:8787`.

---

## Local development

Use two terminals: one for the Worker backend, one for the frontend.

**Terminal 1 — backend (Cloudflare Worker, port 8787):**

```bash
npm run dev:signal
# equivalent: npm run dev --workspace backend
```

**Terminal 2 — frontend (Vite, port 5173):**

```bash
npm run dev
# equivalent: npm run dev --workspace frontend
```

Open <http://localhost:5173>. To test a transfer:

1. In one browser tab/window, pick files or text and create an invite.
2. Copy the invite link into a second tab/browser/device.
3. Watch the encrypted transfer run.

> `localhost` is treated as a secure context, so Web Crypto and WebRTC work without HTTPS. For cross-device LAN testing, use HTTPS (for example a tunnel) or deploy.

Optional backend smoke test while `wrangler dev` is running:

```bash
node backend/test-integration.mjs
```

---

## Testing

```bash
npm test                               # frontend + backend tests
npm run test:frontend                  # frontend only
npm run test:backend                   # backend only
npm run test:watch --workspace frontend
```

Tests cover:

- Base64 / base64url round-trips
- IV length + uniqueness
- ECDH → HKDF shared-key agreement
- Salt, link-secret, and passphrase separation
- AES-GCM AAD + ciphertext tamper detection
- Chunk/frame pack/unpack and full encrypt → decrypt pipelines
- Sender/receiver delivery, completion ack, and final-chunk race regressions
- Store-and-forward encryption/decryption paths
- R2 Range parsing and resumable stored downloads
- ZIP writer behavior for Download all bundles
- PWA production output checks

---

## Deployment

Deploy the **backend first**, note its URL, then build/deploy the **frontend** pointing at it.

### Backend → Cloudflare Workers

```bash
cd backend

# Authenticate wrangler with your Cloudflare account (one-time)
npx wrangler login

# Create the R2 bucket once if using Send for later
npx wrangler r2 bucket create securesend-blobs

# Deploy Worker + Durable Objects + R2 binding
npm run deploy        # runs `wrangler deploy`
```

Wrangler prints a URL like `https://securesend-signal.<your-subdomain>.workers.dev`. The WebSocket endpoint is the same host with `wss://`.

**Lock down production origins** in `backend/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://<your-app>.pages.dev"   # comma-separated if multiple
ROOM_TTL_SECONDS = "600"
RECONNECT_GRACE_SECONDS = "15"
STORE_TTL_SECONDS = "86400"
```

Re-run `npm run deploy` after changing Worker vars.

> **Free plan note:** Durable Objects on the Workers free plan must use SQLite-backed migrations. This repo already uses `new_sqlite_classes` in `wrangler.toml`.

### Frontend → Cloudflare Pages

Set the production frontend env vars so the app talks to your deployed Worker. Create `frontend/.env.production` or set the same values in Pages build settings:

```dotenv
VITE_SIGNAL_URL=wss://securesend-signal.<your-subdomain>.workers.dev
VITE_APP_BASE_URL=https://<your-app>.pages.dev
VITE_ICE_SERVERS=stun:stun.l.google.com:19302
```

Build from the repository root or frontend workspace:

```bash
npm run build
# outputs frontend/dist
```

**Option A — Pages via Git integration:**

In Cloudflare dashboard → Pages → Create project → connect your repo:

- **Build command:** `npm run build`
- **Build output directory:** `frontend/dist`
- **Root directory:** repository root
- Add the `VITE_*` environment variables above under Settings → Environment variables

**Option B — Direct upload with Wrangler:**

```bash
npx wrangler pages deploy frontend/dist --project-name securesend
```

`public/_headers` and `public/_redirects` are copied into `dist` and applied automatically by Pages.

> **TURN for restrictive networks:** plain STUN is enough for many NATs, but symmetric NATs/firewalls may need TURN. Set Cloudflare Calls TURN secrets or static TURN secrets as described in `.env.example` / `backend/wrangler.toml`. TURN relays only encrypted bytes.

---

## Configuration / environment variables

All frontend config is via Vite env vars. **These are not secrets.**

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `VITE_SIGNAL_URL` | frontend | `ws://localhost:8787` | WebSocket base URL of the Worker backend |
| `VITE_APP_BASE_URL` | frontend | `location.origin` | Base used to build invite links |
| `VITE_ICE_SERVERS` | frontend | Google STUN | Comma-separated STUN/TURN fallback servers |
| `ALLOWED_ORIGINS` | backend (`wrangler.toml`) | `*` | Allowed CORS / WebSocket origins; set to your Pages origin in prod |
| `ROOM_TTL_SECONDS` | backend | `600` | Default/fallback invite lifetime |
| `RECONNECT_GRACE_SECONDS` | backend | `15` | Window to reclaim a live role after refresh |
| `STORE_TTL_SECONDS` | backend | `86400` | Stored ciphertext expiry in seconds |
| `STORE_BYTE_CAP` | backend | `2147483648` | Optional per-IP stored-byte cap |
| `STORE_BYTE_WINDOW_MS` | backend | `86400000` | Optional per-IP stored-byte window |
| `TURN_TOKEN_ID` / `TURN_API_TOKEN` | backend secrets | unset | Cloudflare Calls TURN credentials |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | backend secrets | unset | Static TURN fallback credentials |

---

## Security notes

- **Live mode has no file upload.** File bytes only travel over the P2P DataChannel. The Worker/DO relays signaling messages only.
- **Store mode is zero-knowledge storage.** R2 receives only AES-256-GCM ciphertext and an encrypted manifest. The decryption secret lives in the invite link fragment and is never sent to the Worker/R2.
- **No private keys on the server.** Live ECDH private keys are non-extractable and stay in the browser.
- **Invite links are secrets.** They carry the room/storage ID and a 32-byte link secret in the URL fragment. Anyone with the full unexpired link can attempt to receive the transfer.
- **Passphrases are optional defense-in-depth.** They are never transmitted and are folded into key derivation.
- **Authenticated chunks.** Filename, MIME, size, total chunks, and chunk index are bound into AES-GCM AAD.
- **Fresh random IVs** are generated per encrypted chunk.
- **Burn-after-download is delayed until confirmed save.** For stored one-time transfers, SecureSend waits until the recipient confirms a save before deleting the R2 copy.
- **HTTPS required.** Web Crypto, WebRTC, service workers, and secure clipboard/share flows require a secure context outside localhost.
- **No sensitive production logging.** Keys, filenames, and file metadata are not logged in production.
- **Best-effort memory hygiene.** Plaintext chunk buffers are zeroed where practical, but JavaScript/GC cannot guarantee full erasure.
- **Tight CSP and headers.** The app avoids inline scripts/styles and ships Cloudflare Pages security headers.
- **Abuse controls.** Room creation and store uploads have separate per-IP rate limits; stored bytes also have an optional rolling byte budget.
- **Origin enforcement on WebSocket upgrades.** The backend checks the `Origin` header against `ALLOWED_ORIGINS` because CORS alone does not protect WebSocket handshakes.

---

## Threat model

**Protected against:**

- A passive/active signaling server reading live file contents.
- A storage server/R2 bucket reading stored files.
- On-path network observers.
- Tampering with encrypted chunks, ordering, or bound metadata.
- Link leakage after expiry, subject to room/blob TTLs.
- Many resource-exhaustion attempts via rate limits and store byte budgets.

**Not fully protected against:**

- Endpoint compromise (malware/browser extensions/screen recording).
- A recipient forwarding the full invite link before expiry.
- Traffic analysis such as approximate size/timing.
- Users ignoring a mismatched safety code in live mode.

---

## Limitations

- Requires a modern browser with **WebRTC** and **Web Crypto**.
- **Live mode** requires both peers online simultaneously. Use **Send for later** for asynchronous delivery.
- **Streaming-to-disk** is available for single-file transfers on browsers with the File System Access API, mainly desktop Chromium.
- On Safari/iOS/Firefox and for multi-file transfers, received data is generally reassembled in memory before saving, so very large transfers are bounded by device memory.
- **Download all ZIP** also builds the ZIP in memory from already-decrypted files; use individual streaming saves for very large single files.
- Some symmetric-NAT networks require TURN.
- Stored transfers remain available until expiry unless burn-after-download is enabled and the recipient confirms a save.

---

## License

MIT. See `package.json`. Provided as-is; review the cryptographic design against your own threat model before relying on it for sensitive data.
