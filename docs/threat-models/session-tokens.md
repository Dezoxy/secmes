# Threat model: self-minted session tokens (Phase 1)

> Date: 2026-06-15. Author: implementation agent. Phase: private-messenger redesign Phase 1.

## Scope

Introduces EdDSA JWTs minted by the API itself, plus rotating HttpOnly refresh tokens backed by an
`auth_sessions` table.

> **Update (2026-06-17, #223 / `phase-6-decommission.md`):** the dual-accept transition is over.
> **Phase 6 removed OIDC**, so `AuthService.verify()` now accepts **only** the self-minted argus
> EdDSA token — the Zitadel JWKS fallback was deleted (`auth.service.ts`). The "dual-accept" and
> "Zitadel" passages below are retained for the historical rationale but **no longer describe a
> live path**; the argus-EdDSA half is exactly what ships today.

---

## §invariant-4 boundary: session signing is not E2EE crypto

**Security invariant #4** reads: _"No hand-rolled crypto. All cryptography goes through the MLS
library in `packages/crypto`."_ The session-token signing in `apps/api/src/auth/session-key.config.ts`
and `session-token.service.ts` is an **accepted, documented exception** — not a violation — for the
following reasons:

1. **`packages/crypto` is an MLS wrapper** scoped to E2EE message-key operations. Its API has no
   concept of "sign a server JWT". Routing session-signing through it would give the E2EE package a
   server-infrastructure responsibility and blur the crypto-blind boundary the MLS wrapper exists to
   preserve.

2. **Session-token signing is server-infrastructure auth**, not E2EE key material. The API holds
   the signing key so it can assert its own identity — the server is *supposed* to hold this key.
   It never touches a message key, a session key, or any content the server is forbidden to see.

3. **This extends an already-ratified exception.** `auth.service.ts` uses `jose`'s `jwtVerify` to
   verify the access token — at Phase 1 this validated both the argus EdDSA token and (in dual-accept
   mode) Zitadel JWKS, cleared in `docs/threat-models/auth-tenant-context.md`; since #223 it verifies
   the argus EdDSA token only. Phase 1 added the *signing* direction of the same library, for the same
   trust domain (server auth infrastructure).

4. **The enforcing Semgrep rule (`argus-crypto-only-in-crypto-package`, `.semgrep/argus.yml:18-27`)
   is a regex allowlist** matching `crypto.subtle|createCipheriv|createHmac|pbkdf2|scrypt|tweetnacl|libsodium`.
   It does not match `jose`, `SignJWT`, `generateKeyPair`, or `EdDSA` — the rule was written to
   catch raw primitive use, not audited-library use.

**The boundary constraint** covers two pre-cleared exceptions, both confined to
`apps/api/src/auth/`:

1. **`jose` + Ed25519** — session signing/verification (`session-key.config.ts`,
   `session-token.service.ts`). Rationale: server-auth infrastructure, not E2EE key material; the
   Semgrep rule does not match `jose`/`SignJWT`/`generateKeyPair`.

2. **`@noble/hashes` Argon2id** — breakglass password verification (`breakglass.service.ts`).
   Same rationale: the password KDF authenticates the operator to the server; it never touches E2EE
   message keys or content. `packages/crypto` has no KDF for server passwords. The Semgrep rule does
   not match `argon2idAsync`. See `docs/threat-models/breakglass-admin.md §invariant-4` for the full
   analysis.

Neither exception may appear in shared utilities, `packages/crypto`, or any other module.
Call-site comments in the affected files point here.

---

## Dual-accept `verify()` — downgrade surface analysis

> ⚠️ **HISTORICAL (#223).** Dual-accept was removed in Phase 6 — `verify()` now runs the **argus
> path only**; there is no Zitadel fallback. The analysis below explains why the *former* dual path
> was downgrade-safe and is kept for that record.

`auth.service.ts verify()` tries our token first, then Zitadel as a fallback.

**Why there is no downgrade path:**

- Two completely separate `jwtVerify` calls. The argus path has `{ issuer:'argus', audience:'argus-api', algorithms:['EdDSA'], key: argusPublicKey }`. The Zitadel path has `{ issuer: cfg.issuer, audience: cfg.audience, algorithms: ALLOWED_ALGS, key: jwks }`. Keys and issuer constraints are bound per-path — there is no merged keyset or union `alg` list.

- An argus token fails Zitadel verification (wrong `iss`/`aud`, wrong signing key). A Zitadel token fails argus verification (wrong `iss`, wrong `alg`/key). Neither family can be mistaken for the other.

- `alg:none` and HS* remain blocked — inherited from the existing `ALLOWED_ALGS` allowlist, which the Zitadel path enforces, and excluded from the argus path's `algorithms:['EdDSA']`.

- `sub` namespacing: argus mints `sub = "argusid:<argus_id>"`. Zitadel-issued subs are external OIDC subjects. The `user_tenant_index` lookup is `WHERE sub = ?` — both are stored separately and there is no collision.

**Timing**: a Zitadel token pays one failed Ed25519 verify before the JWKS path. This is O(μs) and not a security-relevant signal — an attacker who controls the token must already hold the correct signing key for either path.

---

## GUC carve-out for pre-tenant refresh lookup

### Pattern

The refresh endpoint receives only the refresh cookie — no bearer token, so no `auth.tenantId`. But
`auth_sessions` is FORCE-RLS tenant-keyed and must not be read without a tenant context.

The solution mirrors the `tenant_invites_accept_flow` carve-out (migration 0028, audit finding
arch-3): a transaction-local `app.session_refresh_hash` GUC scopes the RLS permissive policy to
exactly one row — the session whose `refresh_token_hash` matches. An unset GUC yields `NULL`, which
makes `refresh_token_hash = NULL` UNKNOWN, exposing **zero rows** (fail-closed).

### Why `tenant_id` from the row is safe for `withTenant()`

`withTenant` requires that `tenantId` comes from the verified session (i.e. server-controlled data),
never from raw client input (see `docs/threat-models/auth-tenant-context.md:25`). In this flow:

- The client sends an opaque 64-hex-char refresh token (256-bit entropy).
- The server computes its SHA-256 hash and sets it as a transaction-local GUC.
- The RLS carve-out exposes exactly one `auth_sessions` row keyed on that hash.
- The `tenant_id` we carry forward into `withTenant()` is read from **that server-held row**, not
  from any claim the client supplied.

This satisfies the `withTenant` contract: the tenant binding is server-derived from a secret the
caller proved they know, not from a value they chose.

### The `nullif(..., '')` guard

`current_setting('app.tenant_id', true)` returns `''` (empty string) on a pooled connection that
previously ran a `withTenant()` transaction, because the transaction-local GUC reverts to its
placeholder default. Without `nullif`, `''::uuid` throws `22P02` and causes latent flaky failures.
All RLS policies in this table use `nullif(current_setting(..., true), '')::uuid` (see migration
0028 for the rationale). The carve-out uses `current_setting('app.session_refresh_hash', true)`
without a cast, which is safe since it compares to a `text` column and returns `NULL` for unset.

---

## Refresh-reuse detection

**Single-use rotation alone is insufficient**: if an attacker steals a refresh token and uses it
before the legitimate user, the attacker gets a new token and the legitimate user later presents an
already-rotated token.

**Reuse detection** closes this gap: when a request presents a refresh token whose row in
`auth_sessions` has `revoked_at IS NOT NULL` (the token was already rotated/revoked), the API:

1. Revokes all remaining active sessions for that `user_id` (family revocation).
2. Logs the event at WARN level (`session.refresh_reuse`).
3. Returns 401.

This forces both the legitimate user and the attacker to re-authenticate, eliminating any window
the attacker has with the stolen token chain.

---

## Revoked-session access-token window (ST-1 — accepted residual)

Refresh-token revocation (above) is enforced on the **refresh** path, but a session's already-minted
**access** token is a **stateless EdDSA JWT** — `AuthService.verify()` (`auth.service.ts`) checks only
signature / `iss` / `aud` / `exp` and the `user_tenant_index` lookup; it does **not** read
`auth_sessions.revoked_at`. So after a session is revoked (logout, admin action, family revocation),
its outstanding access token keeps working on **normal (non-admin) routes** until it expires.

- **Bound:** the access-token TTL is **10 minutes** (`session-token.service.ts` `mintAccessToken()`
  `.setExpirationTime('10m')`). The exposure window is therefore ≤10 min and self-closing — no new
  access token can be minted, because the refresh path *is* revocation-checked (reuse detection +
  non-active-user block).
- **Admin routes close it immediately:** only `AdminGuard` (`admin.guard.ts`) re-reads
  `auth_sessions.revoked_at` per request and 401s a revoked session — so the higher-value admin
  surface has **no** window. The residual is confined to ordinary user routes.
- **Why accepted (not a per-request denylist):** a stateful revocation lookup on every request trades
  the dominant cost (a DB hit per call) against a residual already bounded by a short TTL; this mirrors
  the in-window-replay decision in `auth-tenant-context.md` §6.
- **Account-delete is fully neutralized (not part of this residual).** `gdpr.deleteAccount` removes the
  `user_tenant_index` row, so `verify()`'s next lookup returns **unbound → 403** on every guarded route,
  regardless of token validity.
- **Member-revoke on the key-directory routes — CLOSED.** `TenantsService.revokeMember()` sets
  `users.status = 'revoked'` but does **not** delete the binding, so a revoked member with an unexpired
  access JWT was, for the ≤10-min TTL, still able to mutate the key directory: `KeyDirectoryService`'s
  `publish` / `revokeUnclaimed` resolved the caller by `auth.sub` / `external_identity_id` with **no
  `status` predicate**, and `claim` / `claimAll` checked only the *target* — so a revoked member could
  drain any in-tenant peer's one-time KeyPackages (`claimAll` burning one per non-provisional device of a
  multi-device target per request). **Fix (this PR):** all four mutations now resolve the caller through
  the shared `requireUser` helper (`messaging/membership.ts`, which filters `status = 'active'`), so a
  revoked caller is rejected with 400 **before** any KeyPackage is read, claimed, or deleted —
  enforced by `key-directory.service.spec.ts` (`describe('revoked caller cannot mutate the key
  directory (ST-1)')`). This also restores the broader `auth-tenant-context.md` §6 claim that
  member-revoke is neutralized on the key-directory paths. The generic ≤10-min window on ordinary
  *read* routes (below) remains the accepted part of this residual.

Revisit alongside any future DPoP / token-introspection work; until then, on ordinary (non-admin, read)
routes the 10-minute TTL is the control and this is a documented, accepted residual — the key-directory
*mutation* paths are now actively revocation-checked via `requireUser` (above).

---

## CSRF posture

The refresh cookie is `HttpOnly + Secure + SameSite=Strict + Path=/auth/session/refresh`.

`SameSite=Strict` is the **primary** CSRF defense: a cross-site request (attacker page → our API)
will not include the cookie on modern browsers.

`X-Argus-Refresh: 1` custom header is **defense-in-depth**: a cross-origin attacker cannot set
a custom header without a CORS preflight that the API refuses (CORS is locked down to the app's
own origin).

This PR adds a deliberate CORS policy (`apps/api/src/main.ts`) that does not echo arbitrary
origins and only allows `X-Argus-Refresh` from the configured `FRONTEND_ORIGIN`.

`Path=/auth/session/refresh` minimises cookie exposure — the cookie is only sent for refresh
requests, not for every API call.

---

## SHA-256 for refresh-token hashing

`createHash('sha256')` (not Argon2id) is used to hash the refresh token at rest.

This is **correct for this use case**. Argon2id is the right KDF for password hashing because
passwords are low-entropy and brute-forceable. A refresh token is `randomBytes(32)` — 256 bits of
CSPRNG output. An attacker who reads the `auth_sessions` table must preimage SHA-256 of 256-bit
entropy, which is computationally equivalent to breaking SHA-256. There is no brute-force attack.

Salting is also unnecessary for the same reason: each token is already a unique 256-bit random
value; a salt would not reduce the SHA-256 preimage resistance.

The lookup is done by hash (DB index equality), not by in-app comparison of stored values, so
timing side-channels on comparison do not apply.

---

## `kid: 'argus-session-v1'` — rotation debt

Access tokens include a static `kid: 'argus-session-v1'` header claim. **Phase 1 does not implement
key rotation** — the `verify()` path uses a single known public key.

**Accepted residual**: without `kid`, adding a second signing key would require a simultaneous
key swap (all outstanding access tokens invalidated, max 10-min window). With the static `kid`,
a future Phase N can introduce `argus-session-v2`, add the new key to the verifier's keyset keyed
on `kid`, and phase out `v1` over a 10-minute window with zero forced re-logins.

---

## §invariant-4 key provisioning

`argus-session-signing-key` is a **mandatory** secret in `infra/stack/secrets/fetch-keyvault-secrets.sh`.
An absent or empty value makes the API fail at boot (fail-closed, per invariant #5). The key must be
provisioned in the target Key Vault **before the first deploy** and whenever you rotate it.

**Generate an Ed25519 PKCS8 PEM key and store it:**

```bash
# AWS — use the bundled helper (idempotent; add --rotate to overwrite):
infra/aws/scripts/populate-keyvault.sh  # runs put_ed25519_key argus-session-signing-key

# Azure Key Vault (manual one-liner; requires az CLI + Key Vault write permission):
TMPKEY=$(mktemp) && \
  openssl genpkey -algorithm Ed25519 -out "$TMPKEY" 2>/dev/null && \
  az keyvault secret set \
    --vault-name "<your-vault-name>" \
    --name argus-session-signing-key \
    --file "$TMPKEY" \
    --encoding utf-8 \
    --only-show-errors >/dev/null && \
  rm -f "$TMPKEY" && \
  echo "argus-session-signing-key provisioned"
```

**Rotation**: generate a fresh key with the same commands. The API reads `SESSION_SIGNING_KEY_FILE` at
startup, so rotation takes effect on the next deploy (or container restart). All outstanding access
tokens (10-min TTL) expire naturally; refresh tokens remain valid and issue new access tokens signed
with the new key. There is no forced re-login window beyond the 10-minute access-token TTL.

---

## Invariants check

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Server is crypto-blind | ✅ Session keys are server-auth infra; no message content involved |
| 2 | No secret logging | ✅ Key bytes never logged; refresh tokens never logged; `session-key.config.ts` has explicit comment |
| 3 | RLS on all tenant tables | ✅ `auth_sessions` has FORCE RLS + two policies (bound + carve-out) |
| 4 | No hand-rolled crypto | ✅ Uses `jose` (audited); see §invariant-4 boundary above |
| 5 | Secrets from Key Vault as files | ✅ `SESSION_SIGNING_KEY_FILE` path; fail-closed in production |
| 6 | No admin path to content | ✅ Session tokens carry `sub` + `sid`; no message content |
