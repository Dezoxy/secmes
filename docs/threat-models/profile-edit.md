# Threat model — Profile editing

**Feature:** `PUT /users/me { displayName?, avatarSeed? }`
**Phase:** Phase 4 of the private-messenger redesign

---

## 1. What this feature does

Allows an authenticated user to update their own `displayName` (a free-text nickname, 1–64 chars) and `avatarSeed` (a short non-PII token used client-side to pick a deterministic generated avatar via DiceBear). Neither field is sensitive. The feature replaces the old Zitadel-driven "display name collision retry" logic; names are now free nicknames, no longer unique per tenant.

---

## 2. Threat surface

| Threat | Impact | Mitigation |
|--------|--------|------------|
| Caller updates another user's profile (IDOR) | Unauthorised data modification | UPDATE scoped to `WHERE id = auth.userId AND tenant_id = auth.tenantId` under RLS — only the caller's own row can be modified |
| Caller changes their `argus_id` (identity hijack) | Breaks identity immutability invariant | `PUT /users/me` body schema has no `argusId` field; Zod strips unknown properties. DB trigger `users_argus_id_immutable` (added in migration 0030) raises an exception if `argus_id` ever changes — last line of defence |
| Caller changes `role` or `status` | Privilege escalation / account suspension bypass | Body schema only allows `displayName` and `avatarSeed`; all other fields are stripped by Zod and not included in the UPDATE SET clause |
| Bulk display-name churn (impersonation via display name) | Confusion / social engineering | Rate limit: 20 requests/min per user (`SENSITIVE_LIMITS.updateProfile`). Display names are free text and never unique, so impersonation resistance relies on argus-id being the stable, canonical identity |
| avatarSeed injection (e.g. XSS via stored seed) | Stored XSS if seed is rendered without escaping | `avatarSeed` is an opaque string stored as-is; the client passes it to DiceBear's deterministic generator — it is NEVER rendered as raw HTML. Length cap (≤64 chars) prevents oversized payloads |
| Display name as injection vector | SQL injection / stored XSS | Drizzle parameterised query; the string is stored and returned as text — rendering is the client's responsibility with appropriate escaping |

---

## 3. argus_id immutability

The `users_argus_id_immutable` BEFORE UPDATE trigger (migration 0030) enforces:

```sql
IF NEW.argus_id IS DISTINCT FROM OLD.argus_id THEN
  RAISE EXCEPTION 'argus_id is immutable';
END IF;
```

This fires for ALL UPDATE statements on the `users` table, including `ON CONFLICT DO UPDATE` paths. `PUT /users/me` never includes `argus_id` in its SET clause, so the trigger never fires in normal operation.

---

## 4. Display name uniqueness removal

Migration 0038 drops `users_tenant_display_name_idx` (the unique index that made display names unique per tenant). Display names are now free nicknames — two users can share the same name. Identity is argus-id only. The collision-retry loop in `user.service.ts provisionFromToken()` is removed.

---

## 5. Invariant check

| Invariant | Status |
|-----------|--------|
| 1. Server is crypto-blind — no message content read | ✅ No message content involved |
| 2. No secrets/tokens/content in logs | ✅ `displayName` is user-chosen metadata, not a secret. `avatarSeed` is non-PII. Neither is logged |
| 3. Every tenant-scoped table has `tenant_id` + RLS | ✅ UPDATE runs via `withTenant()` under the RLS-enforced `users` table |
| 4. No hand-rolled crypto | ✅ No crypto in this endpoint |
| 5. Secrets via Key Vault — no env secrets | ✅ No secrets involved |
| 6. No admin path to content | ✅ Returns 204 No Content only; no content fields |

---

## 6. Audit coverage

`users.profile_updated` audit event on success with:
- `actorSub` (caller's subject)
- `fields: ['displayName', 'avatarSeed']` (which fields were updated — never their values)

Never log `displayName` or `avatarSeed` values in audit events.
