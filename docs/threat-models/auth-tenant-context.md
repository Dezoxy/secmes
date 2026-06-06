# Threat model: OIDC JWT validation + tenant guard (API edge)

> Status: **DRAFT for ratification.** Covers roadmap checkpoints 13–15 (API auth + tenant derivation + JIT) and now the **SPA login flow + token handling** (§8) and **local Zitadel bootstrap** (§9, checkpoint 9) — how the API authenticates a request and establishes the **verified** tenant context that `rls-tenant-isolation.md` then enforces at the database. This note owns the *edge*; that note owns the *database*. Together they implement invariant #3.

## 1. Feature & data flow

A client sends `Authorization: Bearer <JWT>` (issued by Zitadel via OIDC Authorization-Code+PKCE). A NestJS guard:

1. Extracts the bearer token (rejects if absent — routes are **deny-by-default**, opt out with `@Public()`).
2. Verifies it with **`jose`** against the issuer's JWKS: **signature**, **issuer**, **audience**, **expiry/nbf**, and an **asymmetric-algorithm allowlist** (RS256/ES256/EdDSA — never `none`, never HS\*).
3. Derives identity from **verified claims only**: `sub` → user external identity; a **configurable verified claim** (`OIDC_TENANT_CLAIM`) → `tenant_id` (UUID-validated).
4. Attaches `{ sub, tenantId }` to the request. All tenant DB access runs inside `withTenant(verifiedTenantId, …)`.

The server still only ever sees ciphertext + metadata — JWT validation touches no message content.

## 2. Assets & trust boundaries

- **Assets:** the tenant binding itself (which tenant a request acts as), user identity, the token.
- **Boundaries:** client↔server (the token is the *only* trust input; everything else in the request is untrusted), and IdP↔server (we trust Zitadel's signature and its asserted claims).

## 3. Threats (STRIDE-lite)

1. **Forged / unsigned / alg-confusion token (Spoofing).** Attacker submits an unsigned token, `alg:none`, or an HS256 token signed with the *public* key (key-confusion). → Verify signature via JWKS with an **asymmetric-only algorithm allowlist**; reject `none`/HS\*.
2. **Token from the wrong issuer or audience (Spoofing).** A valid token minted for another app/realm. → Enforce `issuer` **and** `audience`; both from server config, never the token.
3. **Tenant context from client input (Spoofing / Elevation — the core risk).** Attacker sets `X-Tenant-Id`, a body field, or a query param to act as another tenant. → `tenant_id` is read **only** from the verified claim; all client-supplied tenant hints are ignored entirely. RLS is the backstop if a handler regresses.
4. **User-settable tenant claim (Confused deputy).** If Zitadel let an end user edit the claim we map to `tenant_id`, they could cross tenants with a *validly signed* token. → **Zitadel-config requirement:** the tenant claim is **IdP-asserted at provisioning** (org-scoped action/metadata), never a user-editable attribute. Documented as a Phase-1 Zitadel wiring gate.
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
- `tenant_id` from `OIDC_TENANT_CLAIM` (configurable so we don't hard-bet Zitadel's claim shape pre-deploy), **UUID-validated** via the same `asTenantId()` the DB layer uses; missing/invalid → 401.
- Ignore every client-supplied tenant hint; DB access only via `withTenant(verifiedTenantId)`.
- **Reviewer:** `security-boundary-auditor`. **Tests gate 13–14:** valid→200; missing / bad-signature / `alg:none` / HS256-with-pubkey / wrong-issuer / wrong-audience / expired → 401; a client `X-Tenant-Id` header is ignored; the tenant claim alone drives isolation.
- **Zitadel-config gate (when deployed):** the tenant claim must be org-asserted, not user-editable.

## 6. Residual risk

- **In-window token replay / no pre-expiry revocation** — accepted for beta; mitigated by short access-token TTL. Revisit with sender-constrained tokens (DPoP/mTLS) and a revocation/introspection path later.
- **Live end-to-end OIDC login** (real Authorization-Code+PKCE against a running Zitadel) is now wired **locally** — see §8 (SPA flow) and §9 (local Zitadel bootstrap). Production Zitadel-on-AKS + Key Vault remains checkpoint 9 proper; the local stack uses throwaway creds and is not a prod posture.

## 7. JIT provisioning (checkpoint 15)

On `POST /auth/session` (login) the user row is created on first sight via an **idempotent upsert** keyed on `(tenant_id, external_identity_id)`, run inside `withTenant(verifiedTenantId)`. All inputs — `tenant_id`, `external_identity_id` (`sub`), `email`, `display_name` — come **only from the verified token**, so a token can create/refresh a user **only in its own tenant** (RLS `WITH CHECK` is the backstop). A verified `email` claim is **required** (Zitadel must grant the `email` scope); absent it, login is `400`, not a partial user. No client-supplied profile field is trusted. Residual: a renamed user's `display_name`/`email` refresh on each login (last-write-wins) — acceptable; the IdP is the source of truth.

## 8. Client login flow & token handling (SPA — checkpoints 9, 13)

The PWA runs **Authorization Code + PKCE (S256)** against Zitadel via **`oidc-client-ts`** (`UserManager`). It is a **public client — no client secret**. The access token is a **JWT** kept in **JS memory only** (never `localStorage`/`sessionStorage`) and attached as `Authorization: Bearer` to API and WS calls — the exact contract the API edge (§1) already validates. Silent renewal uses a refresh token (`offline_access`) held in memory; logout clears local session state and calls Zitadel's end-session endpoint.

**Decision — in-browser PKCE, not a server-side BFF/cookie exchange.** Rationale: (a) it matches the API's existing bearer contract with **zero new server surface** — no token-exchange endpoint, no cookie session, no CSRF layer, no second auth scheme on the WS gateway (which does first-frame bearer auth); (b) the usual reason to prefer an httpOnly cookie — XSS exfiltrating the token — is **weak for an E2EE app**: any script running in our origin already sees decrypted message plaintext and the in-use MLS keys, so moving only the OIDC token behind a cookie does not reduce the dominant risk. The effective XSS control is **CSP + SRI + SW pinning (checkpoint 43)**, which protects *everything*, not just the token. BFF/cookies remains available as later defense-in-depth. (This supersedes the earlier "exchange server-side" comment in `apps/web/src/lib/auth.ts`.)

**Front-channel threats**

- **Authorization-code interception (Spoofing/Tampering):** PKCE S256 binds the code to a one-time verifier held in `sessionStorage` for the round-trip only; `state` (and `nonce` where used) are generated with the CSPRNG and verified in the callback. An intercepted code is useless without the verifier.
- **Open redirect / redirect-URI swap (Spoofing):** Zitadel is configured with an **exact-match** `redirect_uri` allowlist (`http://localhost:5173/auth/callback` locally); the callback rejects a `state` mismatch.
- **Token theft via XSS (Information disclosure):** token in memory + short TTL; real mitigation is CSP/SRI (#43). Accepted residual below.
- **CSRF:** not applicable — auth is a bearer header set explicitly by JS, never an ambient cookie; the OAuth `state` covers the login round-trip itself.
- **Secret/token in logs (Info disclosure):** the SPA never logs the token or the `code`; invariant #2 holds client-side too.

## 9. Local Zitadel bootstrap (dev only — checkpoint 9 stand-in)

Zitadel + its own PostgreSQL run in `compose.yaml` with **local-only throwaway credentials** (never real secrets; invariant #5 is about cloud creds via Key Vault, which this does not touch). Production Zitadel-on-AKS behind Key Vault + Workload ID is checkpoint 9 proper. Bootstrap is **scripted** (a one-shot init container, like `createbuckets`) so `make up` yields a ready IdP and surfaces the issuer + SPA client id for `.env`.

- **JWT access tokens:** the OIDC app is configured to mint **JWT** (not opaque) access tokens so the API validates via JWKS with no introspection round-trip.
- **Tenant claim is IdP-asserted, not user-editable (closes §3 threat #4):** the API requires the tenant claim to be a **UUID** (it casts to `tenants.id`). Zitadel org ids are numeric snowflakes, so a **fixed dev tenant UUID** is seeded into `tenants`, and an **org-scoped Action** asserts `tenant_id=<that UUID>` into the access token. The end user cannot edit it. The exact Action/claim mechanism is pinned in the bootstrap script and **verified against current Zitadel (v4) docs** at implementation time, not assumed. Multi-org→tenant onboarding is Phase 7 (G1).
  - **Carry-forward requirement for the Phase-7 production Action** (the local one uses a hardcoded constant, so this doesn't bite yet): when `tenant_id` is derived from real per-org data it MUST (a) read the org→tenant mapping from **IdP-asserted org metadata only** (never a user-writable attribute), and (b) **overwrite** the claim (set-then, not Zitadel's set-if-absent `setClaim`), so a `tenant_id` a user managed to get emitted *earlier* in the token pipeline can never survive and win with a validly-signed token (§3 threat #4).
- **Reviewers:** `infra-reviewer` (compose + bootstrap) and `security-boundary-auditor` (the auth wiring). **Gate tests** extend §5's: a real login yields a token that the API accepts, provisions the user JIT in the seeded tenant, and a request with no/!expired token fails closed.
