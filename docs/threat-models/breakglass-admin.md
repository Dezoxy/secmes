# Threat model: breakglass admin (Phase 3)

> Date: 2026-06-17. Author: implementation agent. Phase: private-messenger redesign Phase 3.

## Scope

Introduces an emergency admin login path — a single username + Argon2id password credential
(`admin_credentials` table) that mints an admin-role session via the Phase 1 `mintSession()`
machinery. The credential is seeded from `ADMIN_BOOTSTRAP_HASH_FILE` (Key Vault optional secret).

---

## Threat summary

| Threat | Mitigation |
|--------|-----------|
| Password brute-force | Argon2id (64 MiB / t=3 / p=1) + lockout after 5 failures |
| Timing oracle (unknown username) | Always run Argon2id — dummy constant on username miss |
| Unthrottled rotate oracle | `rotate` shares the same lockout counter as `login` |
| Lockout-DoS via rotate | `rotate` checks `locked_until` before KDF — same as login |
| Bootstrap bricks the API | `ADMIN_BOOTSTRAP_HASH_FILE` is OPTIONAL; absent = 503, not boot failure |
| Attacker rotates the key via stolen session | `rotate` requires `currentPassword` (re-auth gate) |
| Stolen session survives after password rotation | `rotate` revokes all active sessions for the breakglass user |
| API restart with existing credential → 503 | Pre-flight SELECT in `bootstrapAdmin()` detects existing credential before attempting insert |
| Lockout during an incident locks out the operator | Non-breakglass SQL unlock runbook (see below) |
| Session is content-capable | Server is crypto-blind (invariant #1); admin sessions see only metadata |

---

## Password as the weakest link

Breakglass is the **highest-privilege credential in the system** — a single shared secret that,
if compromised, grants full admin-role access to tenant metadata, device management, invite
issuance, and SSO configuration. It is weaker than the passkey path by design (a passkey is
phishing-resistant; a password is not) and exists solely as a recovery mechanism for the passkey
path being unavailable.

**Residual**: the password is the single weakest link. The lockout + Argon2id KDF cost make
online guessing infeasible, but an offline attack on an exfiltrated hash is bounded only by the
KDF's memory-hardness. The threat model for a passkey-primary system accepts this residual
because:

1. Breakglass is not the primary auth path — it is never shown in the UI.
2. The `admin_credentials` table is under FORCE RLS with `tenant_id` isolation; an attacker
   cannot read the hash without already having a DB-level compromise.
3. Argon2id at 64 MiB / t=3 / p=1 makes offline cracking expensive even on custom hardware.

**Alerting recommendation**: fire an out-of-band alert on every `breakglass.login_succeeded`
audit row. Breakglass usage should be rare; any login is an operational anomaly worth reviewing.

---

## Timing-oracle defence

The login endpoint must not reveal whether a username exists via response-time differences.

**Implementation:**

- At module load (once, not per request), `BreakglassService.onModuleInit()` computes a
  constant dummy Argon2id output over a random 32-byte input with a random 16-byte salt, using
  the same `PARAMS = { m: 65536, t: 3, p: 1 }` as real hashes. Stored as `dummyHash` and
  `dummySalt` on the service instance.

- For every login attempt — regardless of whether the username exists — the service calls
  `argon2idAsync` exactly once, against the stored hash/salt if the user was found and against
  `dummyHash/dummySalt` otherwise. Response time is dominated by the 64 MiB KDF; the negligible
  variance in the DB lookup does not create an exploitable oracle.

- `timingSafeEqual` (Node.js `node:crypto`) compares the candidate hash to the stored hash;
  this eliminates the short-circuit comparison timing leak from a naive `===`.

- Both "username not found" and "wrong password" return `401 invalid credentials` with identical
  response bodies. Only a locked account returns a distinct response (`423`), because:
  - The username is a fixed, operator-known value (not a secret) — "this account is locked"
    reveals nothing an attacker doesn't already know.
  - The lockout check fires **before** the KDF, preventing a locked account from also being a
    free 64 MiB-per-attempt DoS amplifier.

---

## Lockout policy

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max attempts | 5 | Matches `MAX_ATTEMPTS` in `webauthn.service.ts`; tight enough to cap online guessing |
| Lockout duration | 15 minutes, flat | Flat window prevents infinite attacker-induced lockout (progressive/doubling would let an attacker keep the real operator locked forever with one guess per window) |
| Lockout response | HTTP 423 | Distinct from 401; legitimate operator knows the account is locked, not that their credentials are wrong |
| Counter reset | On success | Re-enables login after a successful authentication |
| Lockout check | Before KDF | Prevents a locked account from being a free Argon2id-DoS amplifier |

### Lockout applies to `rotate` too

`POST /auth/breakglass/rotate` verifies the current password before accepting a new one. It
**shares the same `failed_attempts` / `locked_until` columns** as the login path. This prevents
`rotate` from becoming an unthrottled password-confirmation oracle: an attacker with a stolen
admin access token cannot use `rotate` to guess the existing password at Argon2id cost per
attempt without hitting the lockout.

### Non-breakglass unlock runbook

Because breakglass is the *recovery path for when the passkey path is broken*, it must itself
have a recovery path that does not depend on any application endpoint. If the account is locked
during an incident, an operator with direct DB access (owner connection) can unlock it:

```sql
-- Run via the owner connection (bypasses RLS / argus_app restrictions).
-- Confirm the tenant_id matches DEFAULT_TENANT_ID before executing.
UPDATE admin_credentials
SET locked_until = NULL,
    failed_attempts = 0
WHERE tenant_id = '00000000-0000-0000-0000-000000000001';
```

---

## Audit coverage

Every breakglass event is recorded via `AuditService.record()` with IP + User-Agent metadata.

| Event type | Fired when |
|-----------|------------|
| `breakglass.locked` | Login attempt on an account with `locked_until > now()` |
| `breakglass.login_failed` | Wrong password (or username miss with a found row) |
| `breakglass.login_succeeded` | Successful login — **treat as an alertable anomaly** |
| `breakglass.rotated` | Password successfully rotated via `POST /auth/breakglass/rotate` |

Rules:
- Never log the password, the hash, or the dummy hash.
- Never log the username on `login_failed` at WARN or above (it is not secret, but logging it
  on every failure invites alert fatigue and the value is operator-known).
- `actorSub` is null on failed/locked events (we cannot trust a username as an actor identity
  until authentication succeeds).

---

## Fail-closed: absent bootstrap file → 503, not boot failure

`ADMIN_BOOTSTRAP_HASH_FILE` is in the `OPTIONAL_SECRETS` array in `fetch-keyvault-secrets.sh`.
An absent or empty file means:
- `BreakglassService.onModuleInit()` logs a WARN and sets `this.provisioned = false`.
- `POST /auth/breakglass/login` returns `503 Service Unavailable` — not `401`, which would be
  an oracle indicating the endpoint exists but credentials are wrong.
- The rest of the API (passkey auth, messaging, admin) is entirely unaffected.

This matches the `BillingService` degraded-mode pattern: an unprovisioned optional secret
degrades only that feature, never the whole stack.

---

## `rotate` re-auth gate

`POST /auth/breakglass/rotate { currentPassword, newPassword }` requires:
1. A valid admin bearer token (JwtAuthGuard + AdminGuard — standard auth pipeline).
2. The **current** breakglass password verified via Argon2id against the stored hash.
3. The lockout counter passes (check before KDF, same as login).

Without the current-password gate, a stolen admin session could silently replace the breakglass
password and lock the real operator out of their own recovery path — turning the recovery
mechanism into attacker persistence. The re-auth gate costs one extra Argon2id verify call.

---

## Atomic lockout counter

The `failed_attempts` increment in both `login()` and `rotate()` is performed by a single atomic
SQL `UPDATE`:

```sql
SET failed_attempts = failed_attempts + 1,
    locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
```

A read-then-write pattern (`newCount = row.failedAttempts + 1; UPDATE SET failed_attempts = $newCount`)
would be vulnerable to concurrent wrong-password requests racing — each reads the same stale count
and writes it back, allowing more than 5 attempts before the lockout fires (CWE-362). The atomic
SQL eliminates this race without any application-level locking.

---

## Session revocation on rotate

`POST /auth/breakglass/rotate` stores the new password hash and then calls
`SessionTokenService.revokeSession(DEFAULT_TENANT_ID, { userId })`, which sets `revoked_at`
on **all active `auth_sessions` rows for the breakglass user** in a single UPDATE.

**Why**: The threat scenario for rotation is credential compromise. If an attacker obtained
the old password and logged in before rotation, they hold a valid refresh token that would
otherwise remain alive for the full 30-day session lifetime. Revoking all sessions at rotation
time closes that window: the attacker's refresh token is invalidated, and their next refresh
attempt returns 401. The legitimate operator must log in again with the new password, which
is the expected and correct outcome of a post-compromise credential rotation.

The caller's own session is also revoked — the caller must re-authenticate with the new password
after rotation. This is by design; the cost of one extra login is acceptable for the assurance
that no prior session can survive a rotation.

---

## `rotate()` credential lookup scope

`rotate()` queries `admin_credentials WHERE user_id = $userId`, where `userId` comes from the
caller's AdminGuard JWT. This is **intentional by design**: only the breakglass user (the one
who logged in via `POST /auth/breakglass/login`) holds a JWT whose `userId` matches the
`admin_credentials` row. A WebAuthn admin or Zitadel admin with an admin JWT would get 503
("breakglass not provisioned") since their `userId` has no matching row.

This means: only the breakglass user themselves can rotate the breakglass credential. Operator-
assisted rotation (a different admin rotating the breakglass credential on behalf of another) is
out of scope. If that use case is ever needed, the query should switch to a singleton lookup
(`WHERE tenant_id = DEFAULT_TENANT_ID LIMIT 1`) — which is safe since there is exactly one row
per tenant by the `admin_credentials_tenant_username_idx` invariant.

---

## Bootstrap atomicity

`BreakglassService.onModuleInit()` creates three rows atomically in a single `withTenant()`
transaction:
1. `users` row — `role='admin'`, `external_identity_id="argusid:<argus_id>"`, `status='active'`
2. `admin_credentials` row — `username='admin'`, hashed password, KDF params
3. (`user_tenant_index` is inserted by `mintSession()` on first login — not needed at bootstrap)

A crash before the tx commits leaves nothing; the next boot re-attempts cleanly. A crash after
commit but before `onModuleInit` returns sets `this.provisioned = false` — a harmless no-op
because the data is already in the DB and the next boot will detect the existing credential row
via the pre-flight SELECT and return early.

**Idempotency guard order matters**: the `users` insert executes before the `admin_credentials`
insert within the tx. On restart with existing data, the `users_tenant_display_name_idx` unique
index (enforcing one display name per tenant) would fire first with a `23505` before the
`admin_credentials_tenant_username_idx` guard is reached — leaving `provisioned=false` even
though the credential is present. The fix is a pre-flight `SELECT FROM admin_credentials`
before the insert loop; if the credential row exists, `onModuleInit` logs and exits immediately.
The `23505` catches in the insert loop remain as a race-condition guard for two pods starting
simultaneously: whichever pod loses the insert race is caught by either the `users` or
`admin_credentials` constraint, both treated as idempotent.

---

## §invariant-4 boundary: Argon2id for password verification

**Security invariant #4** reads: _"No hand-rolled crypto. All cryptography goes through the MLS
library in `packages/crypto`."_ The Argon2id password hashing/verification in
`apps/api/src/auth/breakglass.service.ts` is a **second accepted, documented exception** —
alongside the `jose` session-signing exception in `docs/threat-models/session-tokens.md
§invariant-4` — for the following reasons:

1. **`packages/crypto` is an MLS wrapper** scoped to E2EE operations. Password hashing for a
   server-side admin credential is *server-auth infrastructure*, not E2EE key material. Routing
   it through `packages/crypto` would give the E2EE package a server-infrastructure
   responsibility and blur the crypto-blind boundary.

2. **`@noble/hashes` is the same library** already used in `packages/crypto/src/key-backup.ts`
   for the Argon2id KDF (same `DEFAULT_ARGON2` params: `{ m: 65536, t: 3, p: 1 }`). The
   package is already audited, already in the lockfile. Adding it as a direct dependency of
   `apps/api` is an explicit, justified import — not new transitive exposure.

3. **The enforcing Semgrep rule** (`argus-crypto-only-in-crypto-package`) matches
   `crypto.subtle|createCipheriv|createHmac|pbkdf2|scrypt|tweetnacl|libsodium`. It does not
   match `argon2id` or `@noble/hashes` — the rule targets raw primitives, not audited library
   calls.

**The boundary constraint**: `@noble/hashes` Argon2id is permitted exclusively inside
`apps/api/src/auth/`. It must not appear in shared utilities, other modules, or outside the auth
boundary.

---

## Hash interchange format (bootstrap file)

`ADMIN_BOOTSTRAP_HASH_FILE` contains a single-line JSON object:

```json
{"hash":"<base64>","salt":"<base64>","m":65536,"t":3,"p":1}
```

- `hash`: standard base64 of the 32-byte raw `argon2idAsync` output
- `salt`: standard base64 of the 16-byte CSPRNG salt
- `m`, `t`, `p`: Argon2id parameters (validated against `MIN_PARAMS = { m: 8192, t: 2, p: 1 }`)

Generate with the bundled helper (uses the same `@noble` code path as the verifier — do NOT
use the system `argon2` CLI, which may use a different base64 encoding):

```bash
echo -n "MyStr0ngPassphrase!" | pnpm --filter @argus/api generate-admin-hash
```

Pipe the output into the Key Vault secret:
```bash
# AWS (idempotent helper):
infra/aws/scripts/populate-keyvault.sh  # or set argus-admin-bootstrap-hash manually

# Azure Key Vault:
echo -n "MyStr0ngPassphrase!" | pnpm --filter @argus/api generate-admin-hash | \
  az keyvault secret set \
    --vault-name "<your-vault-name>" \
    --name argus-admin-bootstrap-hash \
    --value "$(cat)" \
    --only-show-errors >/dev/null && echo "provisioned"
```

---

## Invariants check

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Server is crypto-blind | ✅ Admin session yields no access to message content |
| 2 | No secret logging | ✅ Password, hash, and dummy hash never logged; audit carries IP+UA only |
| 3 | RLS on all tenant tables | ✅ `admin_credentials` has FORCE RLS + `admin_credentials_isolation` policy |
| 4 | No hand-rolled crypto | ✅ Uses `@noble/hashes` Argon2id; see §invariant-4 boundary above |
| 5 | Secrets from Key Vault as files | ✅ `ADMIN_BOOTSTRAP_HASH_FILE`; fail-closed (503) when absent |
| 6 | No admin path to content | ✅ Admin sessions expose only metadata; `AdminGuard` gates metadata endpoints only |
