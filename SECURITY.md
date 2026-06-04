# Security Policy

SecureSend is an end-to-end encrypted, peer-to-peer file transfer app. We take
security seriously and appreciate responsible disclosure.

## Threat model (in brief)

- **Files are end-to-end encrypted** in the browser with AES-256-GCM. The
  encryption key is derived from an ECDH key exchange (plus an optional
  passphrase and the invite link's secret) and **never leaves the peers'
  devices**.
- **The signaling server is a "dumb pipe."** It relays WebRTC/ICE and the
  peers' *public* keys only. It never sees file bytes, private keys, or the
  derived AES key.
- **Optional store-and-forward** (Cloudflare R2) holds only client-encrypted
  ciphertext, with a short TTL. The server cannot decrypt it.
- **MITM resistance** relies on the out-of-band safety code (key fingerprint)
  that both peers can compare; an attacker who relays a swapped public key
  produces a different safety code.

Issues that undermine any of the above (key leakage, the server gaining access
to plaintext or keys, a safety-code bypass, etc.) are the highest priority.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** to open a private advisory.
3. Include a description, reproduction steps, affected version/commit, and
   potential impact.

We aim to acknowledge reports within a few days and to keep you updated as we
investigate and ship a fix. Please give us a reasonable window to remediate
before any public disclosure.

## Supported versions

This project is deployed as a live web app, so the **currently deployed version
on `main`** is the one that receives security fixes. There are no long-lived
release branches.
