# Threat model: OIDC JWT validation + tenant guard (API edge)

> Status: **DRAFT for ratification.** Covers roadmap checkpoints 13–14 — how the API authenticates a request and establishes the **verified** tenant context that `rls-tenant-isolation.md` then enforces at the database. This note owns the *edge*; that note owns the *database*. Together they implement invariant #3.

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
- **Live end-to-end OIDC login** (Zitadel deployed, real Authorization-Code flow) is not provable until checkpoint 9; this note + tests cover the **API validation half** (13) and the **tenant derivation** (14), proven with locally-minted tokens.
