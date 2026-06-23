# 07 - Live Domain Security Overview

Status: point-in-time active/passive review of `https://4rgus.com`
Date: 2026-06-23
Runner: Codex from the local development workstation
Repo anchor: `eb2e849f`

## Scope

This review covers the public internet-facing posture of `4rgus.com`: DNS, TLS, HTTP headers,
Cloudflare/Caddy routing, unauthenticated API behavior, Cloudflare Access gates, WebSocket auth
posture, malformed-input handling, and common sensitive-path probes.

This was intentionally bounded. It did not include brute force, rate-limit stress, credential attacks,
destructive endpoints, authenticated tenant-isolation testing, or production crawling with a high-volume
scanner. Those belong on staging or on explicitly provisioned test tenants.

## Executive Summary

The live posture is materially strong for a solo-operated E2EE SaaS. Cloudflare is in front, TLS is
modern, the CSP is enforcing and tight, public docs/metrics are not exposed through the API, breakglass
and admin surfaces are Cloudflare Access-gated, protected API reads do not leak unauthenticated data,
and the WebSocket gateway rejects unauthenticated subscription attempts.

No direct content/data exposure was found in this bounded active pass.

The important gaps are edge/config hardening rather than an observed app-level auth break:

1. `sw.js` is publicly served with `Cache-Control: max-age=14400`, even though the service worker is a
   high-trust code-delivery control and the repo Caddy policy expects revalidation for non-hashed assets.
2. `Strict-Transport-Security` is absent on the live HTTPS response.
3. Missing static/security paths fall through to the SPA with `200`; under `/assets/*`, the fallback HTML
   also inherits immutable one-year caching.
4. API responses expose `X-Powered-By: Express`.
5. Live Cloudflare Access appears to gate `/api/admin/*`, while `infra/stack/caddy/Caddyfile` documents
   that `/api/admin/*` is not supposed to be Access-gated. This may be intentional edge policy, but it is
   a config/documentation mismatch to reconcile.

## Test Method

The active tests were single-request, low-rate checks using `curl`, `openssl`, `dig`, and one Node
WebSocket client. Representative checks:

```bash
curl -sSIL https://4rgus.com/
curl -sSIL https://4rgus.com/sw.js
curl -sSIL -H 'Origin: https://evil.example' https://4rgus.com/api/healthz
curl -sSIL -X OPTIONS -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Authorization,Content-Type,X-Argus-Refresh' \
  https://4rgus.com/api/healthz
curl -sSIL -H 'Cf-Access-Jwt-Assertion: fake.attacker.value' https://4rgus.com/admin
curl -sS -X POST -H 'Content-Type: application/json' --data '{bad-json' \
  https://4rgus.com/api/auth/webauthn/authenticate/options
```

The WebSocket auth check opened `wss://4rgus.com/ws`, sent a subscribe frame before auth, then attempted
an invalid auth token. The socket closed with `4401 not authenticated`.

## Results

### DNS and Mail

Observed:

- `4rgus.com` resolves through Cloudflare IPv4 and IPv6 addresses.
- Nameservers are Cloudflare (`jamie.ns.cloudflare.com`, `koa.ns.cloudflare.com`).
- MX points to iCloud.
- DMARC is strict: `v=DMARC1; p=reject; ...; adkim=s; aspf=s`.
- SPF is present but soft-fail: `v=spf1 include:icloud.com ~all`.
- No CAA, DS, or DNSKEY records were visible through normal DNS lookups.
- `www.4rgus.com` did not resolve.

Assessment:

Cloudflare-fronted DNS and strict DMARC are good. CAA and DNSSEC are missing hardening layers. SPF can
move to `-all` after confirming iCloud is the only authorized sender.

### TLS and Redirects

Observed:

- `http://4rgus.com/` redirects to `https://4rgus.com/`.
- TLS 1.2 and TLS 1.3 negotiate successfully.
- TLS 1.0 and TLS 1.1 were not available to the local OpenSSL client.
- Certificate issuer: Google Trust Services `WE1`.
- Certificate SANs: `4rgus.com`, `*.4rgus.com`.
- `Strict-Transport-Security` was absent.

Assessment:

The TLS baseline is good. Missing HSTS is the main edge transport gap.

### Security Headers

Observed on `https://4rgus.com/`:

- `Content-Security-Policy` is enforcing, not report-only.
- `script-src 'self'`; no `unsafe-inline`, `unsafe-eval`, `data:`, or `blob:` script source.
- `connect-src` is pinned to same-origin, `wss://4rgus.com`, and the single production B2 bucket host:
  `https://attachment-r8xq4m7z2p9n6k3v.s3.eu-central-003.backblazeb2.com`.
- `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and `form-action 'self'`.
- `Permissions-Policy` is tight.
- `Referrer-Policy: no-referrer`.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- `Strict-Transport-Security` absent.

Assessment:

The CSP posture is strong and specifically addresses the previous B2 wildcard exfil concern. Missing HSTS
is still a live edge gap.

### Code Delivery and PWA Controls

Observed:

- `/bundle-manifest.json` is public and includes SHA-384 entries.
- Live `sw.js` includes an inlined asset integrity map and fail-closed logic returning `502` with
  `Asset integrity check failed` on hash mismatch.
- Live `sw.js` is served as `Cache-Control: max-age=14400`.
- Static entry HTML is served with `Cache-Control: no-cache`.
- Hashed `/assets/*` are served as immutable.

Assessment:

The service-worker integrity control appears deployed, which is the right direction for dynamic imports
that cannot carry native SRI. The cache policy is not right for `sw.js`: four hours of browser/edge caching
is too long for the script that enforces code-delivery integrity and update behavior.

### Public Route and Admin Exposure

Observed:

- `/api/healthz` returns `200` with a minimal JSON health response.
- `/api/docs`, `/api/openapi.json`, and `/api/metrics` return API `404`.
- `/metrics` falls back to SPA HTML with `200`; it did not expose Prometheus metrics.
- `/admin`, `/api/auth/breakglass`, and `/api/auth/breakglass/login` redirect to Cloudflare Access.
- A spoofed `Cf-Access-Jwt-Assertion: fake.attacker.value` still redirects to Cloudflare Access.
- `/api/admin/devices` and `/api/admin/audit` also redirect to Cloudflare Access.

Assessment:

No public admin/docs/metrics exposure was observed. The spoofed Access-header check behaved correctly.
The `/api/admin/*` Access behavior should be reconciled with repo comments, because the Caddyfile says the
admin API is not Access-gated so normal app-admins can use it through the in-app UI.

### Unauthenticated API Behavior

Observed unauthenticated GET checks:

- `/api/me` -> `401 missing bearer token`.
- `/api/conversations/{uuid}/messages` -> `401 missing bearer token`.
- `/api/friends` -> `401 missing bearer token`.
- `/api/users/lookup?argusId=test` -> `401 missing bearer token`.
- `/api/me/export` -> `401 missing bearer token`.
- `/api/conversations` -> `404 Cannot GET /conversations` because the collection is not GET-exposed.

Observed malformed JSON POST checks:

- `/api/auth/webauthn/authenticate/options` -> controlled `400` JSON.
- `/api/auth/register/redeem` -> controlled `400` JSON.
- `/api/attachments` -> controlled `400` JSON.
- `/api/friends/requests` -> controlled `400` JSON.

Assessment:

The active unauthenticated probes did not expose protected data. Malformed JSON returned controlled errors
without stack traces. The parser error includes position text, which is normal and not sensitive.

### CORS

Observed:

- With `Origin: https://evil.example`, API responses still return
  `Access-Control-Allow-Origin: https://4rgus.com`, not the attacker origin.
- With `Origin: null`, API responses also return `Access-Control-Allow-Origin: https://4rgus.com`.
- Preflight responses allow credentials and known headers, but still do not echo the disallowed origin.

Assessment:

This is not the catastrophic `Access-Control-Allow-Origin: *` plus credentials pattern. Browsers will not
grant `evil.example` or `null` read access because the response origin does not match the request origin.
It would be cleaner to omit CORS headers entirely for disallowed origins, but the observed behavior is not
a credentialed cross-origin read break.

### WebSocket

Observed:

- `wss://4rgus.com/ws` accepts the network connection.
- A `subscribe` frame before auth closes the socket with `4401 not authenticated`.
- An invalid token does not produce data.

Assessment:

The tested path confirms the gateway does not join rooms or emit message data before auth.

### Common Sensitive Paths and Traversal-Shaped Inputs

Observed:

- `/.env`, `/.git/config`, `/package.json`, `/security.txt`, and `/.well-known/security.txt` return SPA
  HTML with `200`; no file contents or secrets were exposed.
- `/assets/index-BXGKDBqt.js.map` returns SPA HTML with `200` and inherits
  `Cache-Control: public, max-age=31536000, immutable`.
- `/%2e%2e/%2e%2e/etc/passwd` and `/api/%2e%2e/%2e%2e/etc/passwd` return Cloudflare `400`.
- `/api/conversations/%2e%2e/messages` returns `401 missing bearer token`.

Assessment:

No traversal or sensitive-file exposure was observed. The SPA fallback behavior is noisy and can mislead
scanners. The `/assets/*` fallback is more concrete: missing assets should not return HTML with immutable
asset caching.

## Recommendations

### Must Fix

1. Fix the live `sw.js` cache policy.
   Why it matters: `sw.js` is privileged code-delivery security logic. It should revalidate on every visit
   or be served with `no-cache`/`no-store` semantics, not a four-hour cache TTL.

2. Add HSTS at the Cloudflare edge and make it testable.
   Why it matters: HTTPS redirect is good, but HSTS prevents silent downgrade after first successful HTTPS
   visit. Start with `max-age=31536000`; add `includeSubDomains` and preload only after subdomain coverage is
   confirmed.

### Should Improve

1. Stop returning SPA HTML for missing `/assets/*` paths.
   Why it matters: missing hashed assets and source maps currently return `200` plus immutable caching. Serve
   real files from `/assets/*` and return `404` for misses before the SPA fallback.

2. Disable `X-Powered-By: Express`.
   Why it matters: it is low-severity fingerprinting noise and costs nothing to remove in Nest/Express.

3. Reconcile Cloudflare Access behavior for `/api/admin/*`.
   Why it matters: live behavior gates `/api/admin/*`, while the Caddyfile says that path is intentionally
   not Access-gated. Either update the edge policy or update the repo docs/config comments so operators know
   the real access model.

4. Add a real `/.well-known/security.txt`.
   Why it matters: scanners and good-faith reporters should get a clear contact/policy file, not SPA HTML.

5. Make disallowed CORS origins fail cleaner.
   Why it matters: the current fixed-origin response is browser-safe, but omitting CORS headers for disallowed
   origins is easier to reason about and easier for scanners to classify.

### Nice To Have

1. Add DNS CAA records.
   Why it matters: constrains which certificate authorities can issue for the domain.

2. Consider DNSSEC.
   Why it matters: adds DNS integrity, useful if the domain becomes a higher-trust production surface.

3. Move SPF from `~all` to `-all` after confirming iCloud is the only sender.
   Why it matters: hard-fail gives receivers a clearer spoofing signal.

4. Decide whether `www.4rgus.com` should exist.
   Why it matters: either redirect it intentionally or leave it absent intentionally; avoid ambiguity in docs
   and external checks.

5. Consider hiding `/caddy-healthz` from the public hostname.
   Why it matters: it exposes no sensitive data, but public health endpoints are usually unnecessary when the
   real probe path is internal.

### Enterprise-Grade Optional

1. Run authenticated DAST on staging with test tenants.
   Why it matters: unauthenticated checks cannot prove tenant isolation, object-level authorization, admin
   metadata boundaries, or destructive-operation protections.

2. Put Cloudflare WAF, rate limits, HSTS, Access policies, and security-header transforms into IaC or a
   checked runbook with smoke tests.
   Why it matters: the remaining live gaps are mostly edge-policy drift risks.

3. Add continuous live header checks.
   Why it matters: CSP, HSTS, `sw.js` cache policy, and Access gating are too important to rely on manual
   inspection.

4. Commission a small external penetration test before onboarding real third-party customers.
   Why it matters: an independent reviewer should test authenticated workflows and business logic with fresh
   assumptions.

## Recommended Next Active Test Plan

Run the next phase against staging or isolated production test tenants:

1. Create two tenants, two regular users, and one admin user.
2. Capture valid access/refresh flows and verify cookies, SameSite, rotation, logout, and revoked-session
   behavior.
3. Attempt IDOR reads/writes across tenants for conversations, welcomes, commits, friends, attachments,
   devices, audit, and admin endpoints.
4. Verify 404-no-oracle behavior for conversation/message/member paths with valid auth but invalid ownership.
5. Exercise attachment upload/download grants and confirm presigned URLs are scoped to the pinned B2 host.
6. Verify rate limits on login/options/redeem/friend request/attachment grant using low-volume threshold tests.
7. Run OWASP ZAP baseline or Burp active scan against staging with the authenticated test account, excluding
   account deletion and any destructive route unless a throwaway tenant is used.
8. Re-run repo gates after any fix:

```bash
pnpm -r typecheck
pnpm -r test
pnpm lint
pnpm format:check
pnpm --filter @argus/api openapi
```

For production, keep active checks single-request and non-destructive unless a maintenance window and test
tenant are explicitly prepared.

