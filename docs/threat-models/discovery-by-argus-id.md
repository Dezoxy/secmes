# Threat model — Discovery by argus-id

**Feature:** `GET /users/lookup?argusId=…`
**Phase:** Phase 4 of the private-messenger redesign
**Status:** Active — supersedes `user-directory.md` (the browsable directory is removed in Phase 5)

---

## 1. What this feature does

Allows an authenticated user to look up a peer by their exact argus-id (e.g. `argus-k7m2q9x4f3n8p1w5-otter`). Returns minimal identity metadata: `userId`, `argusId`, `displayName`, `avatarSeed`. The returned `userId` feeds directly into the existing conversation-create flow.

This replaces `GET /users` (browsable tenant directory) which is removed in Phase 5.

---

## 2. Threat surface

| Threat | Impact | Mitigation |
|--------|--------|------------|
| User enumeration via prefix/fuzzy search | Reveals membership of the user pool | Exact match only (`= argus_id`), no `LIKE`, no prefix, no fuzzy |
| Enumeration via error oracle (valid-format vs. invalid-format) | Reduces brute-force search space | Any argus-id string (valid format or not) returns the same 404 body — no 400 for "bad format" |
| Brute-force enumeration across the 16-char ID space | Information disclosure | Hard rate limit: 10 requests/min per IP via `SENSITIVE_LIMITS.lookupUser` |
| Unauthenticated bulk scraping | Mass data harvest | Endpoint requires a valid bearer token — `@Public()` NOT set |
| Email or PII leakage in response | Privacy violation | Response is `{ userId, argusId, displayName, avatarSeed }` only — no email, no role, no tenant metadata beyond what's derivable from an argus-id |
| Cross-tenant lookup | Unauthorised data access | Query runs under `withTenant(auth.tenantId)` — RLS enforces tenant scope; in the single-tenant design, all users share DEFAULT_TENANT_ID |
| Inactive-user oracle (found-but-inactive vs. not-found) | Reveals revocation state | Service returns `null` for both "row not found" and "row found but `status ≠ active`" — controller responds 404 in both cases |

---

## 3. Enumeration resistance analysis

The argus-id space is `16 chars × unambiguous-28-char alphabet × N animals`. At 10 req/min per IP, exhausting even a 1000-user pool by brute force would require ~10^21 requests — not a practical attack. The rate limit exists to make scanning the space visible in logs and expensive for attackers, not as the sole control.

The exact-match SQL predicate (`WHERE argus_id = $1`) scans at most one row via the `users_argus_id_idx` index. Prefix patterns (`LIKE 'argus-k7m2%'`) are not exposed.

---

## 4. Invariant check

| Invariant | Status |
|-----------|--------|
| 1. Server is crypto-blind — no message content read | ✅ Endpoint returns user metadata only; no message content |
| 2. No secrets/tokens/content in logs | ✅ Logs audit `users.lookup` event with `argusId` + result (found/not-found); no email, no displayName |
| 3. Every tenant-scoped table has `tenant_id` + RLS | ✅ Query runs via `withTenant()` under the RLS-enforced `users` table |
| 4. No hand-rolled crypto | ✅ No crypto in this endpoint |
| 5. Secrets via Key Vault — no env secrets | ✅ No secrets involved |
| 6. No admin path to content | ✅ Returns user metadata only; admin role not required or exposed |

---

## 5. Audit coverage

`users.lookup` audit event on every call (regardless of found/not-found) with:
- `actorSub` (the caller's argus-id subject)
- `targetArgusId` (the queried id — not the userId; this is the non-PII "what was searched for")
- `found: true | false`
- IP + UA metadata

Never log `displayName`, `email`, or `avatarSeed` in audit events.

---

## 6. Supersedes

`docs/threat-models/user-directory.md` — the browsable `GET /users` endpoint is replaced by this exact-match path in Phase 4 (endpoint removed in Phase 5). The old threat model remains for historical reference but is marked retired.
