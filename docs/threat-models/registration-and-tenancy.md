# Threat model: passkey registration and tenancy (Phase 2)

> Covers the code-redemption + WebAuthn registration ceremony and the DEFAULT_TENANT_ID tenancy model.
> Read alongside `passkey-auth.md` (authentication ceremony) and `session-tokens.md` (token minting).
>
> **Note (post-#223):** this note was written while passkey users coexisted with legacy OIDC users.
> The OIDC-coexistence references below (T6 "existing OIDC tenants", T7's "deferred to Phase 6" email
> null-out, T9's Zitadel-sub example) are now **historical** — Phase 6 removed OIDC, nulled all stored
> `email`, and purged legacy non-`argusid:` subjects (`phase-6-decommission.md`). The passkey
> registration ceremony itself (T1–T5, T8) is current and unchanged.

## Scope

`POST /auth/register/redeem`, `POST /auth/webauthn/register/options`, `POST /auth/webauthn/register/verify`,
migration `0033_webauthn.sql`, `webauthn_challenges` table, DEFAULT_TENANT_ID bootstrap.

---

## T1 — argus_id must be generated once and flow unchanged through the entire registration ceremony

**Threat:** if `argus_id` is regenerated at `/register/options` or at `/register/verify`, the `userID` bytes
in the WebAuthn credential differ from what the `users` row holds. Discoverable authentication then fails:
the browser returns a `userHandle` that doesn't match `users.argus_id`, and the T3 guard in `passkey-auth.md`
rejects it.

**Mitigation (mandatory invariant):**
1. `argus_id` is generated **once** in `redeemCode()` via `generateArgusId()` from `users/argus-id.ts`.
2. It is persisted on the `webauthn_challenges` row immediately (`argus_id` column, NOT NULL for register
   ceremonies).
3. `getRegistrationOptions()` reads `challenge.argus_id` from the row — it does NOT regenerate.
4. `verifyRegistration()` reads `challenge.argus_id` from the deleted-RETURNING challenge row and uses that exact
   value for the `users` insert, `user_tenant_index` insert, and `userID` derivation cross-check.

---

## T2 — Atomic code-consume: no reusable-code window

**Threat:** the invite code is consumed before the WebAuthn ceremony completes. If verify fails (network error,
bad attestation), the code is permanently spent and the user cannot re-register.

**Mitigation:**
- The invite code (`tenant_invites.accepted_at`) is marked consumed **only inside the verify transaction**,
  not at redeem. Redeem only reads the invite (GUC carve-out SELECT) and creates a challenge row.
- The verify transaction is atomic (`withTenant(DEFAULT_TENANT_ID, tx => { ... })`):
  - DELETE challenge row (`webauthn_challenges`, no-RLS)
  - UPDATE `tenant_invites SET accepted_at=now() WHERE id=... AND accepted_at IS NULL RETURNING *`
  - Verify WebAuthn attestation
  - INSERT user + user_tenant_index + webauthn_credentials
  - If ANY step fails, the Postgres transaction rolls back → `tenant_invites.accepted_at` stays NULL → user
    can retry the full flow from `redeemCode`.
- A crash between verify-commit and `mintSession()` leaves a registered user with no active session.
  **Recovery:** the user logs in via `POST /auth/webauthn/authenticate/options` + `/verify` on their next visit
  (their credential row exists; they just lack a refresh cookie). This is acceptable.

---

## T3 — Single-use enforcement: no double-redemption

**Threat:** the same invite code is redeemed twice (race condition or replay).

**Mitigations:**
- `redeemCode()` performs a `SELECT ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`.
  A used or revoked invite returns 401 at this step.
- `verifyRegistration()` UPDATE enforces `AND accepted_at IS NULL` again as the final lock. The first committer
  wins (Postgres serializable update + RETURNING — if `accepted_at` is already set, 0 rows returned → 409).
- Challenge delete-on-use: `DELETE … RETURNING` on `webauthn_challenges` means only one concurrent
  `verifyRegistration` can proceed per `ceremonyId`.

---

## T4 — Challenge expiry

**Threat:** a user starts registration but doesn't complete the WebAuthn ceremony (browser crash, network timeout).
The challenge sits in `webauthn_challenges` indefinitely and could be replayed later.

**Mitigations:**
- `expires_at = NOW() + INTERVAL '5 minutes'` set at INSERT.
- `redeemCode()`, `getRegistrationOptions()`, and `verifyAuthentication()` all check `expires_at > now()`.
- A periodic sweep (recommended: pg_cron or external cron): `DELETE FROM webauthn_challenges WHERE expires_at < now()`.
  This is a cleanup backstop; delete-on-use is the primary control.

---

## T5 — `webauthn_challenges` as a no-RLS routing table

**Threat:** a no-RLS table could leak data across tenants if accessed without proper filtering.

**Justification (mirrors `user_tenant_index`, migration 0028 GUC pattern):**
- During registration there is no tenant context (no authenticated user yet). RLS requires `app.tenant_id`,
  which is only known after the user row is created.
- The table holds only: `ceremony_id` (server-generated UUID), `challenge_hash` (SHA-256 of random bytes),
  `purpose`, `argus_id`, `invite_id`, `expires_at`. No tenant-private data.
- Access is gated by `ceremony_id` (UUID, server-generated, ≥122 bits of randomness — practically unguessable).
  An attacker with a ceremony ID can only read back what the server gave them.
- `argus_id` on the row is the server-generated value, not a user claim.
- **No-RLS is documented in the migration comment** per AGENTS.md conventions.

---

## T6 — DEFAULT_TENANT_ID model

**Threat:** making all passkey users share one tenant could create cross-tenant data leaks or break existing
OIDC multi-tenant isolation.

**Mitigations:**
- `DEFAULT_TENANT_ID` is a fixed UUID constant (`00000000-0000-4000-8000-000000000001`), inserted into
  `tenants` idempotently on migration.
- All FORCE RLS policies remain in force; the single shared tenant is just one tenant whose RLS predicate
  is satisfied by `app.tenant_id = DEFAULT_TENANT_ID`.
- Existing OIDC tenants are unaffected — their `tenant_id` values are different UUIDs; their RLS isolation
  is unchanged.
- Phase 10 (locked decision): tenancy is effectively single-tenant by choice, enforced in code by hardcoding
  `DEFAULT_TENANT_ID` in the passkey service.

---

## T7 — `users.email` nullable: no PII collection for passkey users

**Threat:** passkey registration inserting `email=NULL` violates a NOT NULL constraint or breaks a contract
that expects `email` to always be a string.

**Mitigation (migration 0033):**
- `ALTER TABLE users ALTER COLUMN email DROP NOT NULL` in the same migration that creates the WebAuthn tables.
- **Contracts relaxed in the same PR**: `MeBound.email`, `UserSummary.email`, `DeviceSummary.email`,
  `MemberSummary.email` all become `nullable()` in `packages/contracts/src/index.ts`.
- Existing OIDC users retain their email values; only new passkey users have `email=NULL`.
- The full email null-out of existing users is deferred to Phase 6 (after the OIDC email writer is removed).

---

## T8 — Invite code brute-force

**Threat:** an attacker tries to guess a valid invite code.

**Mitigation:**
- `tenant_invites` token is 32 bytes of CSPRNG (256-bit entropy) — computationally infeasible to brute-force.
- `POST /auth/register/redeem` is rate-limited (IP-keyed, `SENSITIVE_LIMITS.passkeyRedeem = 10/min`).
  The rate limit is a DoS guard (heavy-path protection), not the primary security control.
- All validation errors return the same 401 response (no oracle for whether a code exists vs. is expired vs. is used).

---

## T9 — `external_identity_id` compatibility

**Requirement:** the `users` table has a unique constraint on `(tenant_id, external_identity_id)`. OIDC users
carry a Zitadel sub (e.g. `176395...@users.zitadel.com`). Passkey users must use a compatible value.

**Mitigation:** passkey users set `external_identity_id = "argusid:" + argus_id`. This is the same format as
`auth.sub` for self-minted tokens (`"argusid:<argus_id>"`), which is the PK of `user_tenant_index` — the
identity spine. The NOT NULL constraint and the unique index both hold.
