# Threat model — admin (breakglass) access gating via Cloudflare Access

**Scope:** gating the breakglass surface (`/admin` UI + `/api/auth/breakglass/*` API) behind
**Cloudflare Access** so the highest-privilege credential is not exposed to the open internet.
The in-app admin panel API (`/api/admin/*`) is NOT behind CF Access — see the design note below.
Companion to [`breakglass-admin.md`](breakglass-admin.md) and [`vm-ingress.md`](vm-ingress.md).

## Change summary

Before: a faint "Admin access" button on the **public** landing page opened the breakglass login inline, and
`POST /api/auth/breakglass/login` (`@Public`, IP-rate-limited + Argon2id + lockout) was callable by anyone on
the internet at `4rgus.com/api`. After: the login lives at `4rgus.com/admin` (off the landing page), and both
`/admin` and the admin/breakglass API are reachable **only** through Cloudflare Access. Two enforcement layers
plus the UI move.

## Design

- **Path, not subdomain.** The admin shares the app's *same* session JWT (`iss=argus`/`aud=argus-api`,
  host-independent), refresh cookie (host-only, `SameSite=Strict`, no `Domain`), and CORS origin
  (`FRONTEND_ORIGIN`, a single value that also drives WebAuthn `expectedOrigin`). A path keeps cookie/CORS/CSP
  unchanged; a subdomain would fork the session-cookie domain and widen the crypto-blind API's CORS allowlist
  for zero token-scoping gain.
- **Frontend (`apps/web`):** the landing "Admin access" button + inline breakglass panel are removed; the
  breakglass login now renders on a standalone `/admin` route (`routes/AdminLoginRoute.tsx`), **not** wrapped
  in `RequireAuth` (it's the unauthenticated door to obtain a session). `BreakglassLogin.tsx` is unchanged.
- **Layer A — edge (Caddy, the load-bearing control):** `infra/stack/caddy/Caddyfile` returns **404** for
  `/admin`, `/admin/*`, `/api/auth/breakglass/*` when the `Cf-Access-Jwt-Assertion` header is absent.
  cloudflared injects that header only on requests that passed the Access policy, and strips any client-supplied
  copy. 404 (not 403) so the routes are indistinguishable from non-existent to an unauthenticated scanner.
  The block is first among the `handle` blocks. The public app, passkey login, end-user `/api` routes, and
  **`/api/admin/*`** are untouched (see design note below).
- **Layer B — app (defense in depth, env-gated):** `CfAccessGuard` on `BreakglassController` verifies the
  `Cf-Access-Jwt-Assertion` signature with `jose` against the team JWKS
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), pinning `iss`=team, `aud`=the Access app's AUD
  tag, `alg`=RS256, expiry. Active only when `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are both set; unset →
  no-op pass-through (dev / un-armed deploy), mirroring the breakglass `ADMIN_BOOTSTRAP_HASH_FILE` and Sentry
  DSN degraded-mode patterns. The assertion and request body are never logged.
- **`/api/admin/*` uses `AdminGuard` only (not CF Access):** the in-app admin panel (Settings → Admin) is
  accessible to any tenant user with `role='admin'`. Requiring CF Access would block regular admins who
  authenticated via passkey but have never gone through the breakglass CF Access flow. `AdminGuard` is
  sufficient: it verifies the Argus EdDSA JWT, checks the session row is not revoked, and asserts
  `users.role='admin'` AND `users.status='active'` in the DB under the tenant RLS context.
- **Cloudflare Access** is dashboard-managed (no Terraform): a self-hosted application on `4rgus.com` scoped to
  the three path prefixes, with an Allow policy for the operator's email (see `docs/architecture/deploy.md`).
- **Dev preserved:** local dev runs Vite (no Caddy, no Access); `/admin` renders and breakglass login works as
  before. Layer A lives only in the prod Caddyfile; Layer B is env-gated off. E2E (no Access) hits `/admin`
  directly.

## Threats & mitigations

| # | Threat | Mitigation |
|---|--------|-----------|
| T1 | **Public, unauthenticated front door to the highest-privilege credential.** Anyone could `POST 4rgus.com/api/auth/breakglass/login` and grind the lockout/Argon2id path. | The endpoint is now unreachable without first passing Cloudflare Access (IdP auth + the operator's email allowlist) at the edge (Caddy 404). Online-guessing surface drops from "the whole internet" to "an authenticated Access session for one email". |
| T2 | **Endpoint / credential discovery.** The landing button advertised that an admin path exists. | Button removed; Caddy returns 404 (not 403) for the admin paths without the Access header — indistinguishable from non-existent routes. |
| T3 | **Password is the only factor (phishable).** Breakglass is username/password by design. | Access fronts it with an IdP gate that can require MFA — a phishing-resistant factor *ahead* of the password. Two independent factors must fail. |
| T4 | **Forged `Cf-Access-Jwt-Assertion` header on breakglass paths.** A request inside the origin network spoofs the header to bypass Access. | Layer A trusts cloudflared header hygiene (it strips client copies; the VM has no inbound ports and only the internal Docker network reaches `caddy:8080` — `vm-ingress.md`). Layer B closes it in prod: `CfAccessGuard` verifies the JWT **signature** + iss/aud/exp, so a forged header without a valid team-signed JWT is rejected. Admin API paths (`/api/admin/*`) do not use this header at all — they rely on `AdminGuard`. |
| T5 | **`alg:none` / algorithm-confusion on the Access JWT.** | `CfAccessGuard` pins `algorithms: ['RS256']` (Cloudflare Access signs RS256); no `none`, no HS/RS confusion. |
| T6 | **Admin reaching message content.** | Unchanged by this PR — admin surfaces are metadata-only by construction (`admin.controller.ts` lists devices/audit; breakglass mints a metadata session). Invariant #6 holds. |

## Residual risk

- **Cloudflare Access is now a trust dependency** for the admin path. If the operator's IdP account / Access
  session is compromised, the attacker reaches the breakglass *form* — but still needs the breakglass password
  (Argon2id + 5-fail/15-min lockout). Two independent factors must fail; strictly better than today.
- **Fail-closed:** if Cloudflare/Access is down, the operator cannot reach breakglass through the gate. By
  design. Recovery-of-last-resort remains the **direct-DB owner runbook** in `breakglass-admin.md` — there is
  deliberately **no "skip Access" escape hatch** (that would recreate the public door).
- **Layer A alone** (header presence) is sufficient for the current single-VM topology; Layer B is enabled in
  prod so a future multi-VM / second-ingress topology can't silently de-fang the gate. In dev Layer B is off
  (no sensitive data).

## Invariant check

1. Crypto-blind — unaffected (admin session is metadata-only). 2. No secret/token logging — `CfAccessGuard`
never logs the assertion or body. 4. No hand-rolled crypto — `jose` is the cleared JWT-verify exception (same
as session tokens). 5. No new secret — `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are public config (env). 6.
No admin path to content — admin surfaces remain metadata-only.
