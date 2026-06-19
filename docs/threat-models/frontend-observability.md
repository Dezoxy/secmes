# Threat model: frontend observability, PWA caching, and hosting headers

> Status: **DRAFT for ratification.** Covers frontend plan Step 14C: production browser safety around
> telemetry boundaries, service-worker caching, browser persistence, bundle visibility, and target static
> hosting headers. No API or database change.

## 1. Feature & data flow

The web app is a Vite-built PWA served as static assets. The browser talks to the API/WebSocket gateway for
metadata and ciphertext envelopes, authenticates same-origin via passkeys (WebAuthn — Zitadel/OIDC was
decommissioned, #223), and fetches S3-compatible B2 presigned URLs for attachments. Decrypted message content exists only in the browser runtime after the client-side crypto path
opens it; it must never enter telemetry, service-worker runtime caches, logs, or hosting diagnostics.

Step 14A made Workbox explicit and static-only: generated JS/CSS/HTML/icons/images are precached, while
auth callbacks, API routes, WebSocket routes, presigned attachment URLs, authorization-bearing requests, and
decrypted content remain network/runtime only. Step 14B added a local telemetry event builder but no sender;
it only accepts stable event identifiers plus primitive technical metadata, rejects sensitive keys/values,
rejects free-form strings, rejects presigned URLs, and rejects non-finite numeric values.

Step 14C adds low-risk bundle visibility during production builds and documents target hosting headers for
the VM/static edge layer. It does not add a telemetry transport and does not change the crypto path.

## 2. Assets & trust boundaries

- **Assets:** decrypted message content in browser memory; auth/session tokens; passkey/WebAuthn state;
  local encrypted message cache; service-worker cache; presigned attachment URLs; telemetry metadata; static
  JS bundles that contain client behavior and crypto glue.
- **Boundaries:** browser runtime ↔ service worker/cache; browser ↔ API/WebSocket (passkey auth is
  same-origin over this boundary, no separate IdP); browser ↔ B2 presigned attachment URL; static host/edge ↔
  user browser; future telemetry sink ↔ app.

## 3. Threats (STRIDE-lite)

- **Information disclosure — sensitive data cached by the PWA.** A runtime cache that captures API responses,
  auth callbacks, presigned URLs, or decrypted content would persist user-specific data outside the intended
  browser stores. → Workbox remains static-precache-only with an explicit navigation denylist and no runtime
  caching. Any future runtime cache must get a dedicated threat-model update.
- **Information disclosure — telemetry becomes a plaintext side channel.** Free-form strings or permissive
  metadata could carry message text, tokens, keys, passphrases, full authorization headers, or presigned URLs
  to a future sink. → The telemetry helper is local-only and rejects sensitive keys/values, free-form string
  metadata, unsupported structured values, and non-finite numbers. A sender is intentionally out of scope.
- **Tampering / injection — XSS expands into token/content exfiltration.** If an injected script runs, it can
  read browser state and decrypted runtime content. → Target static hosting must send a restrictive CSP:
  `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  and narrowly scoped `connect-src` entries for the same-origin API/WebSocket plus the single B2 attachment
  bucket host. (Auth is passkey-only — Zitadel/OIDC was decommissioned, #223 — so there is no IdP origin in
  `connect-src`.) CSP is defense-in-depth; React escaping and no plaintext server path remain required.
- **Information disclosure — referrers leak callback or attachment URLs.** Auth callback parameters and
  presigned URLs can contain sensitive material. → Target header: `Referrer-Policy: no-referrer`.
- **Clickjacking / embedding.** An attacker could frame the app and trick users into sensitive actions. →
  Target header: `Content-Security-Policy: frame-ancestors 'none'`.
- **Unexpected browser permissions.** A future browser prompt could request camera, microphone, geolocation,
  payment, or USB-like APIs that the messenger does not need. → Target header: `Permissions-Policy` denying
  unused capabilities by default.
- **MIME confusion.** Mis-served static assets could be interpreted as executable content. → Target header:
  `X-Content-Type-Options: nosniff`.
- **Performance regression hidden in large bundles.** Client crypto and chat code can grow until initial
  load is slow, encouraging risky ad-hoc splitting later. → The build prints the largest generated JS/CSS
  assets. Route-level lazy loading is deferred until those measurements identify a concrete split that does
  not complicate the chat startup path.

## 4. Invariant check

1. **Crypto-blind server** — upheld. This slice affects browser build/hosting behavior only; the server still
   stores and forwards ciphertext only.
2. **No secret/plaintext logging or persistence** — upheld. Bundle reporting prints generated asset names and
   byte sizes only, never source snippets, tokens, URLs, or content. Telemetry remains local and rejects
   sensitive metadata.
3. **tenant_id + RLS** — N/A; no database tables or API endpoints.
4. **No hand-rolled crypto** — upheld; no crypto code is added.
5. **Secrets via Key Vault** — N/A; no runtime secrets are introduced.
6. **No admin content path** — upheld; the threat model explicitly keeps decrypted content out of telemetry,
   caches, and hosting diagnostics.

## 5. Decision & mitigations

- Add a dependency-free Vite build plugin that reports the largest generated JS/CSS assets by byte size.
- Keep route imports unchanged in this slice; chat startup stays eager until bundle visibility justifies a
  concrete lazy split.
- Hosting headers — **now served by Caddy** at the app origin (#43; `infra/stack/caddy/Caddyfile`), `caddy validate`
  clean, smoke-test the CSP against the live app at arming:
  - `Content-Security-Policy` with restrictive defaults — `script-src 'self'` (no inline scripts; ts-mls is
    pure JS so no `wasm-eval`), `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and
    `connect-src` scoped to same-origin (REST/WS) + the **exact** B2 presigned-URL bucket host
    (`attachment-r8xq4m7z2p9n6k3v.s3.eu-central-003.backblazeb2.com`, virtual-host style — CSP-1 resolved
    2026-06-19: the former wildcard `*.s3…` and the bare path-style `s3.<region>.backblazeb2.com` endpoint are
    both removed, pinned to the single bucket host in `infra/stack/caddy/Caddyfile`) — no IdP origin, since passkey auth replaced
    Zitadel (#223); `img-src 'self' data: blob:` for generated avatars +
    decrypted attachment object URLs.
  - `Referrer-Policy: no-referrer` (tightened from `strict-origin-when-cross-origin`).
  - `Permissions-Policy` denying unused sensor/hardware capabilities.
  - `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` (defense-in-depth alongside `frame-ancestors`).
  - Optional COOP/COEP later only after checking service-worker and attachment-origin behavior.
  - **#43 (frontend build) DONE:** SRI on the built bundles (`vite-plugin-sri3`), service-worker pinning (Caddy
    `no-cache`/`immutable` cache policy), and a published bundle hash (`bundle-manifest.json`) — see
    `code-delivery-integrity.md`.
- Gates: `pnpm --filter @argus/web typecheck`, `pnpm --filter @argus/web build`, full frontend PR gate, CI,
  and Codex review.

## 6. Residual risk

- **Headers are wired (#43) but the CSP isn't runtime-verified yet.** They are served by Caddy
  (`infra/stack/caddy/Caddyfile`, `caddy validate` clean), but nothing has loaded the app *through* Caddy with the
  CSP enforced — smoke-test against the live app at arming and watch the browser console for violations
  (eyeball the B2 presigned upload/download + the same-origin REST/WS calls specifically). The other #43 frontend-build
  items (SRI, service-worker pinning, published bundle hash) have since shipped — see `code-delivery-integrity.md`.
- **CSP `connect-src` is scoped to the single-origin VM topology.** Same-origin REST/WS rely on `'self'`
  (no IdP origin — Zitadel was decommissioned, #223). The B2 attachment egress is **pinned (CSP-1, resolved
  2026-06-19) to the single virtual-host bucket** `https://attachment-r8xq4m7z2p9n6k3v.s3.eu-central-003.backblazeb2.com`;
  the former wildcard `*.s3.eu-central-003.backblazeb2.com` and the bare path-style `s3.<region>.backblazeb2.com`
  host are removed (both over-permitted into the shared-tenant region namespace — a CSP source is host-only and
  cannot restrict the path). The pin is enforced on two legs: `scripts/check-csp-connect-src.sh` fails CI if the
  Caddyfile host and `deploy.sh`'s `ATTACHMENT_BUCKET` literal drift (static↔static), and `deploy.sh` fails the
  deploy **closed** if the runtime `S3_BUCKET` — the bucket the API actually presigns against, a repo variable
  CI can't see — differs from that host. Together they guarantee the browser's only allowed B2 host equals the
  presign bucket. A **split deployment** (`VITE_API_URL`/`VITE_WS_URL`
  on a different host) would silently break live delivery until `connect-src` is extended with that explicit
  origin — a too-wide `connect-src` would also weaken the protection.
- **No telemetry sender exists yet.** When one is added, it needs a separate PR and threat-model update that
  covers retention, EU data residency, opt-in/default behavior, and failure handling.
- **Bundle visibility is not a budget.** It reports size but does not fail CI. A hard budget can be added
  after current bundle baselines and acceptable thresholds are agreed.
- **COOP/COEP deferred.** Cross-origin isolation can improve security for some browser APIs but may break
  auth, service-worker, or attachment flows if enabled prematurely.
