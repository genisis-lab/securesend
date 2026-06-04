# Changelog

All notable changes to SecureSend are documented in this file.

## [Unreleased]

### Fixed

- **Signaling: removed dead reconnect-grace logic.** The `SignalingRoom`
  Durable Object kept a `reservedRoles` map (set on disconnect, pruned on
  connect) that was supposed to hold a peer's slot for
  `RECONNECT_GRACE_SECONDS`, but it was never consulted when assigning a role
  (`accept()` only checks `peers.has(...)`), and the client ignores the
  server-assigned slot and sends no reclaim token. The reservation therefore
  had no effect. Removed `reservedRoles`, `graceSeconds()`,
  `pruneReservations()`, and the unused `RECONNECT_GRACE_SECONDS` var, and
  corrected the comments: a disconnected peer's slot is freed immediately and
  can be reclaimed by a reconnecting peer until the room's TTL alarm fires.
  (No behavior change — dead code removal.)
- **Crypto: corrected the encryption-flow doc comment.** The header claimed an
  optional passphrase is mixed into the HKDF `info` parameter; in fact
  `deriveSharedAesKey` folds the PBKDF2-stretched passphrase into the HKDF
  *input keying material* (IKM) alongside the ECDH secret and link secret
  (`info` stays `HKDF_INFO_BASE`). Updated the comment to match the code.

### Changed

- **Crypto: strengthened passphrase stretching.** Raised PBKDF2-HMAC-SHA256
  from 100,000 to 600,000 iterations (current OWASP guidance), via a new
  `PBKDF2_ITERATIONS` constant.

### Added

- **CI pipeline** (`.github/workflows/ci.yml`): on pushes to `main` and on PRs,
  runs `npm ci`, then lint, typecheck (frontend + backend workspaces), test,
  and frontend build.

### Deployment notes

- **Frontend changes deploy automatically** via Cloudflare Pages on push to
  `main` (crypto.ts).
- **Backend changes require a manual deploy.** `backend/src/room.ts` and
  `backend/wrangler.toml` only go live after running the backend deploy
  (`npm run deploy:backend` / `wrangler deploy`); Pages auto-deploy does not
  cover the Worker.
- **Verify `ALLOWED_ORIGINS`.** `backend/wrangler.toml` still ships the
  placeholder `https://your-app.pages.dev`. Confirm the live Worker's
  `ALLOWED_ORIGINS` is set to your real Pages origin(s), or room creation from
  the production site will be blocked by CORS.
- **PBKDF2 change + store-and-forward:** a store-and-forward blob encrypted by
  an older client version can only be decrypted by a recipient running the same
  version. Such blobs expire within 24h (`STORE_TTL_SECONDS`), so the mismatch
  window after deploy is short.
