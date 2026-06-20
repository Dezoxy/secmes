# Threat model: API-edge JWT validation + tenant guard

> ⚠️ **SUPERSEDED IN PART (2026-06-17, #223 / `phase-6-decommission.md`).** The OIDC/Zitadel
> machinery this note describes — JWKS verification, Authorization-Code+PKCE in the SPA
> (`oidc-client-ts`, `Callback.tsx`), the local Zitadel bootstrap (§9), and the "Status:
> IMPLEMENTED" claims in §8 — was **removed**. Shipped reality: the API mints **and** verifies
> its own **EdDSA (`iss:argus` / `aud:argus-api`) session token** with a locally-held key
> (`apps/api/src/auth/auth.service.ts` `verify()` + `session-token.service.ts` `mintAccessToken()`);
> there is **no remote JWKS fetch and no OIDC IdP**. Login is **passkey-only** (WebAuthn). The
> **still-current** parts of this note are the *tenant-derivation* model — verified-`sub` →
> `user_tenant_index` lookup, deny-by-default guard, "tenant context never from client input,"
> RLS backstop — which the self-minted-token path preserves unchanged. For the live design read
> **`session-tokens.md`** (token minting/verification), **`passkey-auth.md`** +
> **`registration-and-tenancy.md`** (login/registration), and **`phase-6-decommission.md`** (what
> was removed and why). Retained as the historical edge-auth design record; the OIDC-specific
> sections below are **not** an attestation of any shipped control.

> Status: **HISTORICAL.** Originally covered roadmap checkpoints 13–15 (API auth + tenant derivation + JIT), the SPA login flow (§8), and local Zitadel bootstrap (§9). The tenant-derivation half still describes shipped behaviour; the OIDC/Zitadel half is superseded per the banner above. This note owns the *edge*; `rls-tenant-isolation.md` owns the *database*. Together they implement invariant #3.

## 1. Feature & data flow

A client sends `Authorization: Bearer <JWT>` (issued by Zitadel via OIDC Authorization-Code+PKCE). A NestJS guard:

1. Extracts the bearer token (rejects if absent — routes are **deny-by-default**, opt out with `@Public()`).
2. Verifies it with **`jose`** against the issuer's JWKS: **signature**, **issuer**, **audience**, **expiry/nbf**, and an **asymmetric-algorithm allowlist** (RS256/ES256/EdDSA — never `none`, never HS\*).
3. Derives identity from **verified claims only**: `sub` → user external identity.
4. Looks up `tenantId` from `user_tenant_index` (DB, keyed on `sub`) — `null` if unbound (new user). Attaches `{ sub, tenantId }` to the request. All tenant DB access runs inside `withTenant(verifiedTenantId, …)`; unbound requests are 403 unless the route carries `@AllowUnbound()`.

The server still only ever sees ciphertext + metadata — JWT validation touches no message content.

## 2. Assets & trust boundaries

- **Assets:** the tenant binding itself (which tenant a request acts as), user identity, the token.
- **Boundaries:** client↔server (the token is the *only* trust input; everything else in the request is untrusted), and IdP↔server (we trust Zitadel's signature and its asserted claims).

## 3. Threats (STRIDE-lite)

1. **Forged / unsigned / alg-confusion token (Spoofing).** Attacker submits an unsigned token, `alg:none`, or an HS256 token signed with the *public* key (key-confusion). → Verify signature via JWKS with an **asymmetric-only algorithm allowlist**; reject `none`/HS\*.
2. **Token from the wrong issuer or audience (Spoofing).** A valid token minted for another app/realm. → Enforce `issuer` **and** `audience`; both from server config, never the token.
3. **Tenant context from client input (Spoofing / Elevation — the core risk).** Attacker sets `X-Tenant-Id`, a body field, or a query param to act as another tenant. → `tenant_id` is read **only** from the verified claim; all client-supplied tenant hints are ignored entirely. RLS is the backstop if a handler regresses.
4. **User-settable tenant claim (Confused deputy).** ~~Superseded by G1.~~ The Zitadel `tenant_id` claim and the `argusClaims` Action have been removed. Tenant assignment now lives in `user_tenant_index` (our DB, not the JWT). The user controls neither their `sub` (IdP-signed) nor the index (INSERT-only by the app role, written by two server-controlled paths: create-tenant and accept-invite). See `tenant-onboarding.md` §5.
5. **Token / claim disclosure via logs (Information disclosure).** → Never log the `Authorization` header or the raw token (invariant #2). Logs carry `sub`/`tenant_id` **ids** only.
6. **Expiry / replay (Tampering).** → Enforce `exp`/`nbf` with small clock tolerance; rely on short-lived access tokens. In-window replay is accepted for beta (see §6).
7. **JWKS fetch / rotation abuse (DoS / Spoofing).** Unknown-`kid` floods or stale keys. → `jose` `createRemoteJWKSet` fetches over **HTTPS** from the configured issuer, caches, and rate-limits `kid` refetch; key rotation is automatic.

## 4. Invariant check

- **#2 (no secret logging):** upheld — tokens/headers never logged.
- **#3 (tenant context from verified token only):** this *is* the mechanism.
- **#4 (no hand-rolled crypto):** JWT/JWKS verification uses **`jose`** (audited), not custom code.
- Server stays crypto-blind (#1), no admin content path (#6), secrets via Key Vault (#5 — the OIDC config is non-secret issuer/audience/JWKS URLs; no client secret in the SPA→API path, PKCE is used). No tension.

## 5. Decision & mitigations

- `jose.jwtVerify(token, JWKS, { issuer, audience, algorithms: ['RS256','ES256','EdDSA'] })`; `createRemoteJWKSet(<issuer>/.well-known/jwks)`. Guard is **request-scoped, deny-by-default**.
- `tenantId` from `user_tenant_index` (DB lookup keyed on `sub`, inside `withRouting()`) — not from a JWT claim. Missing binding → unbound state (`tenantId: null`), 403 on non-@AllowUnbound routes.
- Ignore every client-supplied tenant hint; DB access only via `withTenant(verifiedTenantId)`.
- **Reviewer:** `security-boundary-auditor`. **Tests gate 13–14:** valid→200; missing / bad-signature / `alg:none` / HS256-with-pubkey / wrong-issuer / wrong-audience / expired → 401; a client `X-Tenant-Id` header is ignored; the tenant claim alone drives isolation.
- **Zitadel-config gate (when deployed):** the tenant claim must be org-asserted, not user-editable.

## 6. Residual risk

- **In-window token replay / no pre-expiry JWT revocation** — the access token is a stateless JWT with no `jti`/denylist. A denylist is **deliberately not built**: it would add a stateful per-request lookup for a residual already bounded by a short TTL + the active-user re-check below (revisit only alongside the DPoP/introspection line). Precisely what this residual does and does NOT cover:
  - **Account-delete and member-revoke are already neutralized on the next request — not residual.** Every tenant-scoped path resolves the caller via `requireUser` (`messaging/membership.ts`), which matches only `status='active'`, and `admin.guard.ts` re-checks status+role per request. `gdpr.deleteAccount` removes the user + `user_tenant_index` row (→ unbound → 403); member-revoke sets `status='revoked'` (→ 400). A still-valid bearer token cannot act after either.
  - **True residual (a):** raw in-window replay of a *stolen* token while the user is still active — bounded by a **short access-token TTL** (below).
  - **True residual (b):** admin **device-revoke** deletes the device row but does not terminate the OIDC session, so the bearer token keeps working until expiry. Inherent E2EE trust-model property (the server cannot recall MLS keys already on the device); a real device cutoff is an MLS remove-commit + a Zitadel session revoke, outside this code path.
  - **Mitigation that must be real:** pin a **short access-token lifetime (~10–15 min)** in Zitadel, leaning on the in-memory `offline_access` refresh token for silent renewal (§8). Zitadel's default is **12h** — too long for the "short TTL mitigates replay" argument. The access-token lifetime is an **instance-level OIDC setting** (Admin API `PUT /admin/v1/settings/oidc` — endpoint + behaviour verified against Zitadel v4.15.0; it is a *full* update, so override only `accessTokenLifetime` and preserve the id/refresh lifetimes), not the per-app config. `provision.sh` now pins it to **900s (15 min)** locally via a GET-then-merge (`ACCESS_TOKEN_TTL` overridable). **Operational requirement (prod): production Zitadel MUST get the same `PUT /admin/v1/settings/oidc` with a short `accessTokenLifetime`** — that instance setting, not anything in this repo, is what actually bounds residual (a).
- **Live end-to-end OIDC login** (real Authorization-Code+PKCE against a running Zitadel) is now wired **locally** — see §8 (SPA flow) and §9 (local Zitadel bootstrap). In production Zitadel runs in Docker Compose on the VM, with its secrets delivered from Key Vault via the VM's Managed Identity (checkpoint 9 proper); the local stack uses throwaway creds and is not a prod posture.

## 7. JIT provisioning (checkpoint 15)

On `POST /auth/session` (login) the user row is created on first sight via an **idempotent upsert** keyed on `(tenant_id, external_identity_id)`, run inside `withTenant(verifiedTenantId)`. All inputs — `tenant_id`, `external_identity_id` (`sub`), `email`, `display_name` — come **only from the verified token**, so a token can create/refresh a user **only in its own tenant** (RLS `WITH CHECK` is the backstop). A verified `email` claim is **required** (Zitadel must grant the `email` scope); absent it, login is `400`, not a partial user. No client-supplied profile field is trusted. Residual: a renamed user's `display_name`/`email` refresh on each login (last-write-wins) — acceptable; the IdP is the source of truth.

## 8. Client login flow & token handling (SPA — checkpoints 9, 13)

> ⚠️ **SUPERSEDED (#223).** This OIDC SPA flow (`oidc-client-ts` `UserManager`, `routes/Callback.tsx`
> code→token exchange, Authorization-Code+PKCE against Zitadel) was **removed**. The PWA now logs in
> **passkey-only** (WebAuthn): `POST /auth/register/redeem` + `/auth/webauthn/*` and a HttpOnly
> rotating refresh cookie — see `phase-5-frontend-passkey.md` and `registration-and-tenancy.md`.
> The "IMPLEMENTED" status below described the *then*-shipped OIDC client; it is **no longer
> accurate** and is kept only as the historical record. The access-token-in-memory + short-TTL
> posture it describes carried over to the passkey flow; the OIDC-specific mechanics did not.

The PWA runs **Authorization Code + PKCE (S256)** against Zitadel via **`oidc-client-ts`** (`UserManager`) — a **public client, no client secret**. The access token is a **JWT** kept in **JS memory only** (an in-memory `userStore`, never `localStorage`/`sessionStorage`) and attached as `Authorization: Bearer` to API calls — the contract the API edge (§1) validates. Silent renewal uses a refresh token (`offline_access`) held in memory; a full page reload intentionally drops the in-memory session (re-login). Logout clears local state and calls Zitadel's end-session endpoint. When OIDC is unconfigured (`VITE_OIDC_*` unset) the SPA runs a seed-driven **demo mode** with no real auth.

**Decision — in-browser PKCE, not a server-side BFF/cookie exchange.** Rationale: (a) it matches the API's existing bearer contract with **zero new server surface** — no token-exchange endpoint, no cookie session, no CSRF layer, no second auth scheme on the WS gateway (which does first-frame bearer auth); (b) the usual reason to prefer an httpOnly cookie — XSS exfiltrating the token — is **weak for an E2EE app**: any script running in our origin already sees decrypted message plaintext and the in-use MLS keys, so moving only the OIDC token behind a cookie does not reduce the dominant risk. The effective XSS control is **CSP + SRI + SW pinning (checkpoint 43)**, which protects *everything*, not just the token. BFF/cookies remains available as later defense-in-depth. (The earlier "exchange server-side" comment in `apps/web/src/lib/auth.ts` was removed accordingly.)

**Front-channel threats** — controls enforced by the SPA login:

- **Authorization-code interception (Spoofing/Tampering):** PKCE S256 binds the code to a one-time verifier held in `sessionStorage` for the round-trip only; `state` (and `nonce` where used) are generated with the CSPRNG and verified in the callback. An intercepted code is useless without the verifier.
- **Open redirect / redirect-URI swap (Spoofing):** Zitadel is configured with an **exact-match** `redirect_uri` allowlist (`http://localhost:5173/auth/callback` locally); the callback rejects a `state` mismatch.
- **Token theft via XSS (Information disclosure):** token in memory + short TTL; real mitigation is CSP/SRI (#43). Accepted residual below.
- **CSRF:** not applicable — auth is a bearer header set explicitly by JS, never an ambient cookie; the OAuth `state` covers the login round-trip itself.
- **Secret/token in logs (Info disclosure):** the SPA never logs the token or the `code`; invariant #2 holds client-side too.

## 9. Local Zitadel bootstrap (dev only — checkpoint 9 stand-in)

> ⚠️ **SUPERSEDED (#223).** Zitadel was removed from both dev (`compose.yaml`) and prod compose, the
> Caddy ingress, the secret-fetch set, and the deploy script (`phase-6-decommission.md` §5). There is
> no IdP in the stack any more; the section below is historical.

Zitadel + its own PostgreSQL run in `compose.yaml` with **local-only throwaway credentials** (never real secrets; invariant #5 is about cloud creds via Key Vault, which this does not touch). In production Zitadel runs in the same Docker Compose stack on the VM, with its secrets delivered from Key Vault via the VM's Managed Identity (checkpoint 9 proper). Bootstrap is **scripted** (a one-shot init container, like `createbuckets`) so `make up` yields a ready IdP and surfaces the issuer + SPA client id for `.env`.

- **JWT access tokens:** the OIDC app is configured to mint **JWT** (not opaque) access tokens so the API validates via JWKS with no introspection round-trip.
- **Tenant claim is IdP-asserted, not user-editable (closes §3 threat #4):** the API requires the tenant claim to be a **UUID** (it casts to `tenants.id`). Zitadel org ids are numeric snowflakes, so a **fixed dev tenant UUID** is seeded into `tenants`, and an **org-scoped Action** asserts `tenant_id=<that UUID>` into the access token. The end user cannot edit it. The exact Action/claim mechanism is pinned in the bootstrap script and **verified against current Zitadel (v4) docs** at implementation time, not assumed. Multi-org→tenant onboarding is Phase 7 (G1).
  - **The `argusClaims` Action has been removed (G1).** Tenant binding is now DB-authoritative (`user_tenant_index`); no Zitadel Action or Management API is needed. The `email`/`name` claims are still emitted via Zitadel's OIDC scope configuration (not an Action) and used for JIT provisioning.
- **Reviewers:** `infra-reviewer` (compose + bootstrap) and `security-boundary-auditor` (the auth wiring). **Gate tests** extend §5's: a real login yields a token that the API accepts, provisions the user JIT in the seeded tenant, and a request with no/!expired token fails closed.
