# Threat model: argus-id identity spine

**Feature:** Phase 0 of the private-messenger redesign — every user row gains a stable, immutable,
system-generated `argus_id` (`argus-<16 chars>-<animal>`) surfaced on `GET /me`.
OIDC auth unchanged; Phase 0 is purely additive.

**Author:** Claude Code  
**Date:** 2026-06-15  
**Status:** approved — implementation begins immediately  
**Supersedes:** n/a (new surface)

---

## 1. Assets and goals

| Asset | Goal |
|-------|------|
| `argus_id` uniqueness | One stable identifier per user, never reused |
| `argus_id` immutability | Lost passkey = new identity (enforced at DB level) |
| Generation unpredictability | argus-ids must not leak user-count or insertion order |
| User pool privacy | Lookup-by-argus-id (Phase 4) must not enable enumeration now |

---

## 2. Trust boundary

- The server **generates** `argus_id` via a CSPRNG-backed TypeScript function (`generateArgusId()`).
- The DB enforces uniqueness (`users_argus_id_idx`) and immutability (BEFORE UPDATE trigger).
- The client **reads** `argus_id` from `GET /me`; it never writes or influences the value.
- The DB default (`gen_argus_id()` via pgcrypto) is a safety net for raw inserts in tests —
  real inserts always supply an app-generated value.

---

## 3. Threats and mitigations

### T1 — Global collision (two users get the same argus_id)
**Impact:** DB unique constraint fires; user provisioning fails.  
**Likelihood:** Negligible. The ID space is 31^16 × 200 ≈ 3.5 × 10²⁵; collisions are impossible at any
realistic user count.  
**Mitigations:**
- `UNIQUE INDEX users_argus_id_idx` on `users(argus_id)` — collision is rejected, not silently overwritten.
- `isArgusIdCollision` in service retry loops catches 23505 on this specific index and regenerates.
- Retry cap of 8 prevents an infinite loop; exhaustion throws loudly (never silently succeeds with a duplicate).

### T2 — Biased generation (RNG leaks ordering)
**Impact:** Attacker infers registration sequence or user count from argus-ids.  
**Likelihood:** Medium if `Math.random` or a biased modulo were used.  
**Mitigations:**
- TypeScript: `node:crypto.randomInt(alphabet.length)` — rejection-sampling-based, provably uniform;
  `Math.random` is banned by the `argus-no-insecure-random` Semgrep rule.
- SQL default: `gen_random_bytes()` (pgcrypto) with rejection sampling per character — only accepted when
  `byte_val < floor(256/31) * 31 = 248`; biased tail (248-255) is discarded.
- Animal selection uses 64 entries (power of 2); `byte % 64` is exactly uniform over a 256-byte space.

### T3 — Immutability bypass via direct UPDATE
**Impact:** User changes their argus_id, detaching their identity or colliding with another user.  
**Mitigations:**
- `users_argus_id_immutable` BEFORE UPDATE trigger raises an exception if `NEW.argus_id IS DISTINCT FROM OLD.argus_id`.
- Column-level REVOKE is not viable (Postgres does not support subtracting a column from a table-level GRANT),
  so the trigger is the correct enforcement mechanism.
- The ON CONFLICT DO UPDATE path in `provisionFromToken` never touches `argus_id` in its SET clause, so
  the trigger fires with `NEW = OLD` and silently passes. Verified that upsert logins are safe.

### T4 — Spec/test raw-insert gap
**Impact:** ~25 existing specs that raw-insert into `users` without supplying `argus_id` would fail at
NOT NULL, breaking the entire test suite.  
**Mitigations:**
- Migration adds `argus_id` as `DEFAULT gen_argus_id()` (volatile). Postgres evaluates the default
  once per row, so each raw insert gets a distinct, CSPRNG-generated argus-id with no code changes
  to the specs.
- The DB default is kept permanently as a safety net; it does not replace the app-level generator for
  real inserts.

### T5 — Pre-Phase-4 enumeration via argus-id
**Impact:** Attacker learns argus-ids of all users via some existing endpoint.  
**Likelihood:** Low in Phase 0 — argus-id is only exposed on `GET /me` (auth-gated, returns caller's own
value only). The directory `GET /users` still exists but does NOT return argus-id.  
**Mitigations:**
- `GET /me` returns only the authenticated user's own argus-id.
- No search-by-substring or list-all endpoint is added in this phase.
- Phase 4 will add exact-match lookup with hard rate-limiting; the threat model for that phase covers
  the enumeration risk in detail.

### T6 — argus-id logged (violates invariant #2)
**Impact:** argus-id is a pseudonymous identity, not a secret, but logging it tied to other metadata
could expose communication patterns.  
**Mitigations:**
- argus-id is NOT key material; logging it in audit events (e.g., `member.revoked`) is acceptable
  (audit carries IDs and metadata, per invariant #2).
- The identity is immutable and public-facing by design (Phase 4 discovery), so logs that carry it
  alongside `actorSub` are consistent with the threat model.

---

## 4. Invariant check

| # | Invariant | Phase 0 impact |
|---|-----------|----------------|
| 1 | Server crypto-blind | No change — argus-id is not message key material |
| 2 | No plaintext/key in logs | argus-id is a pseudonymous identifier, not a secret or key; OK to log |
| 3 | Every tenant table has tenant_id + RLS | `users` unchanged; no new table |
| 4 | No hand-rolled crypto | CSPRNG via `node:crypto.randomInt` + pgcrypto; no new primitive |
| 5 | Secrets from Key Vault | No secrets introduced |
| 6 | No admin path to content | argus-id is metadata; admin sees it in Phase 3 admin bootstrap |

---

## 5. Residual risks

- **argus-id persistence after account deletion:** GDPR/erasure path (`/me/gdpr-erase`, migration 0020)
  nulls `senderUserId` on messages but does not yet scrub `argus_id`. Phase 6 or a dedicated erasure
  migration should null `argus_id` on deletion and scrub `user_tenant_index` entries. Tracked in
  open item §7.2 of the redesign plan.
