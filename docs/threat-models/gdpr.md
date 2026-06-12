# Threat Model — GDPR Pack (G6)

**Roadmap item**: G6  
**Endpoints**: `GET /me/export`, `DELETE /me`  
**Coverage**: GDPR Art. 17 (erasure), Art. 20 (portability)

---

## What the server holds about a user

The server is **crypto-blind** — it never holds message plaintext, content keys, or attachment decryption keys. All message content is end-to-end encrypted before it reaches the API. The export therefore contains **metadata only**:

| Category | Exported? | Notes |
|---|---|---|
| Profile (email, display name, role, status) | ✅ | |
| Devices (IDs + created timestamps) | ✅ | Public key material is not exported |
| Key backup existence + timestamps | ✅ | Backup ciphertext is never returned |
| Conversation membership | ✅ | IDs + timestamps only |
| Message counts per conversation | ✅ | Counts + time range only; no ciphertext |
| Attachment metadata | ✅ | Object key, byte size, timestamps |
| Push subscription prefix | ✅ | First 40 chars of endpoint URL only |
| Audit events (own activity) | ✅ | IDs + metadata only |
| Invites created | ✅ | |
| Message ciphertext | ❌ | Server crypto-blind |
| Attachment ciphertext | ❌ | Lives in object storage, never served |
| Content keys | ❌ | Exist only in MLS envelopes |
| Other users' data | ❌ | RLS enforced per-tenant |

---

## Threat: export as a data-scraping vector

**Mitigations**:
- Rate-limited to **2 requests/hour** per verified user (`perHour(SENSITIVE_LIMITS.exportMyData)`).
- Requires a valid bearer token (JwtAuthGuard applies globally).
- Query runs within `withTenant()` — RLS policies block cross-tenant reads at the Postgres layer.

---

## Threat: accidental account deletion

**Mitigations**:
- `DELETE /me` requires `X-Confirm-Delete: my-account` header — without it the API returns 400.
- Rate-limited to **3 requests/day** per verified user.
- Deletion is scoped to `tenant_id` + `external_identity_id` — a user in tenant B cannot delete a user in tenant A even if they guess the UUID.

---

## Deletion cascade map

The deletion runs inside a single DB transaction (`withTenant()`). Order respects NO-ACTION FK constraints:

1. **`conversation_welcomes`** — deleted explicitly (NO-ACTION FKs on both `sender_user_id` and `recipient_user_id`; cascade covers recipient via `conversation_members` but not sender). **Note:** an offline recipient who has not yet fetched their Welcome before the sender deletes their account loses the ability to join that MLS group. This is intentional — there is no clean NO-ACTION FK alternative — and the impact is bounded to group join, not to ciphertext already delivered.
2. **`messages.sender_user_id`** — set to `NULL` (pseudonymized). Keeps ciphertext accessible for offline recipients who are entitled to it. The server cannot read the ciphertext anyway.
3. **`tenant_invites.accepted_by`** — set to `NULL` (nullable FK, no ON DELETE clause).
4. **`conversations.created_by`** — set to `NULL` (NO-ACTION FK; conversation and members' ciphertext must survive the creator's erasure).
5. **`attachments`** — deleted explicitly (NO-ACTION FK on `uploaded_by`). Object keys collected atomically via `DELETE…RETURNING`.
6. **`audit_events`** — deleted explicitly where `actor_sub = auth.sub` (NO-ACTION string FK; rows survive user deletion otherwise). Personal data in the audit log is erased under Art. 17; event type and tenant context for rows by other actors are unaffected. Requires migration 0021 (`grant delete on audit_events to argus_app`).
7. **`users`** row — deleted last; cascades:
   - `devices` → `key_packages` (CASCADE), `push_subscriptions` (CASCADE)
   - `key_backups` (CASCADE)
   - `conversation_members` (CASCADE) → `conversation_receipts` (CASCADE)
   - `tenant_invites.created_by` (CASCADE)
8. **`user_tenant_index`** — deleted via `withRouting()` after the tenant transaction (pre-tenant table, no RLS).

After the transaction, attachment blobs are deleted **best-effort** from object storage:
- Rows are already gone, so no new download grant can be issued.
- Blob content is encrypted ciphertext; without the content key (which lived only in MLS envelopes) it is unreadable.
- Backblaze B2 lifecycle rule reaps unreferenced blobs within 2 days as a backstop.
- Deletion failures are logged (`logger.warn`) but not surfaced to the caller.

---

## Threat: Zitadel identity not deleted

**Known gap**: this API deletes the internal user record but does **not** delete or revoke the external Zitadel identity. A tenant operator must revoke the user in the Zitadel admin console.

**Why**: Zitadel is outside this service's trust boundary. The API does not hold Zitadel admin credentials.

**Runbook** (§6 of this file):
1. Navigate to the tenant's Zitadel organization in the admin console.
2. Locate the user by email or external ID.
3. Delete or deactivate the user account.
4. Optionally revoke any active sessions.

Until step 3 is complete, the identity can still authenticate — but the bearer token issued by Zitadel will fail JIT provisioning (the user row is gone) and all API calls will return 404 or 401 depending on the path.

---

## Security invariants maintained

1. **Server stays crypto-blind** — export contains only metadata, never ciphertext or content keys.
2. **No cross-tenant reads** — every DB query runs under `withTenant(tenantId)` with RLS in effect.
3. **No admin path to content** — the export endpoint is self-service only; no admin surface exposes another user's export.
4. **Deletion is scoped** — the user can only delete their own account within their own tenant.
