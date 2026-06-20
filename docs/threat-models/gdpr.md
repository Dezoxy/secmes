# Threat Model — GDPR Pack (G6)

**Roadmap item**: G6  
**Endpoints**: `GET /me/export`, `DELETE /me`  
**Coverage**: GDPR Art. 17 (erasure), Art. 20 (portability)

---

## What the server holds about a user

The server is **crypto-blind** — it never holds message plaintext, content keys, or attachment decryption keys. All message content is end-to-end encrypted before it reaches the API. The export therefore contains **metadata only**:

| Category | Exported? | Notes |
|---|---|---|
| Profile (argus ID, display name, avatar seed, role, status, created-at) | ✅ | **No email** — passkey users have no email on file; the profile row is `users.{argus_id, display_name, avatar_seed, role, status, created_at}` only (`gdpr.service.ts` `exportAccount`) |
| Devices (IDs + created timestamps) | ✅ | Public key material is not exported |
| Conversation membership | ✅ | IDs + timestamps only |
| Message counts per conversation | ✅ | Counts + time range only; no ciphertext |
| Attachment metadata | ✅ | Object key, byte size, timestamps |
| Push subscription prefix | ✅ | First 40 chars of endpoint URL only |
| Friendships + open requests | ✅ | Other user's ID, status, direction (incoming/outgoing — pending only), timestamps |
| Audit events (own activity) | ✅ | IDs + metadata; scoped to **both** the legacy Zitadel sub (`external_identity_id`) and the argus sub (`argusid:<id>`) so a token-family switch leaves nothing behind |
| Invites created | ✅ | |
| Message ciphertext | ❌ | Server crypto-blind |
| Attachment ciphertext | ❌ | Lives in object storage, never served |
| Content keys | ❌ | Exist only in MLS envelopes |
| Other users' data | ❌ | RLS enforced per-tenant |

> **Removed:** the former "Key backup existence + timestamps" row — the server-side `key_backups`
> table was dropped (`0040_drop_key_backups.sql`); keys are sealed client-side under a WebAuthn-PRF
> key with **no server backup** (`prf-keystore-unlock.md`). The export holds no key-backup data.

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

The deletion runs inside a single DB transaction (`withTenant()`), followed by a routing-index cleanup and a best-effort blob delete. Order respects NO-ACTION FK constraints:

> **Guard — breakglass-admin cannot self-delete.** `DELETE /me` on the `breakglass-admin` account returns 403: its `users` row is FK-referenced by `admin_credentials` (ON DELETE RESTRICT), so erasing it would disable the emergency-login path until re-provision (a denial-of-recovery).

1. **`conversation_welcomes`** — deleted explicitly (NO-ACTION FKs on both `sender_user_id` and `recipient_user_id`; cascade covers recipient via `conversation_members` but not sender). **Note:** an offline recipient who has not yet fetched their Welcome before the sender deletes their account loses the ability to join that MLS group. This is intentional — there is no clean NO-ACTION FK alternative — and the impact is bounded to group join, not to ciphertext already delivered.
2. **`messages.sender_user_id`** — set to `NULL` (pseudonymized). Keeps ciphertext accessible for offline recipients who are entitled to it. The server cannot read the ciphertext anyway.
3. **`conversation_commits.sender_user_id`** — set to `NULL` — same lifecycle as messages: the commit ciphertext stays accessible to entitled members, only the sender identity is erased (NO-ACTION FK, migration 0023).
4. **`tenant_invites.accepted_by`** — set to `NULL` (nullable FK, no ON DELETE clause).
5. **`conversations.created_by`** — set to `NULL` (NO-ACTION FK; conversation and members' ciphertext must survive the creator's erasure).
6. **`attachments`** — deleted explicitly (NO-ACTION FK on `uploaded_by`). Object keys collected atomically via `DELETE…RETURNING`.
7. **`audit_events` (actor rows)** — deleted where `actor_sub` matches **either** the user's Zitadel sub (`external_identity_id`) **or** their argus sub (`argusid:<argus_id>`) — **dual-sub**, so a token-family switch leaves no orphan. Rows authored by *other* actors keep their event type + tenant context. Requires migration 0021 (`grant delete on audit_events to argus_app`).
8. **`audit_events` (target scrub — ER-1)** — for rows authored by *other* actors that name this user as the **target** (a `users.lookup` / `friends.request_created` row carrying `metadata.targetArgusId = <this argus_id>`), the `targetArgusId` key is surgically removed from the JSONB (`metadata - 'targetArgusId'`) rather than the row deleted — preserving the other user's legitimate audit history while erasing this user's identifier. Tenant-scoped (a probe recorded under another tenant is out of scope by design). Needs the column-scoped `update (metadata)` grant from migration 0043. **(F4: `audit_events.metadata` *can* name a probed argus-id — this scrub is what closes it on erasure.)**
9. **`users`** row — deleted last; cascades:
   - `devices` → `key_packages` (CASCADE), `push_subscriptions` (CASCADE)
   - `auth_sessions` (CASCADE — migration 0032)
   - `webauthn_credentials` (CASCADE — migration 0034)
   - `device_enrollments` (CASCADE — migration 0024)
   - `friendships` (CASCADE on both `user_low_id`/`user_high_id` — migration 0042)
   - `conversation_members` (CASCADE) → `conversation_receipts` (CASCADE)
   - `tenant_invites.created_by` (CASCADE)
10. **`user_tenant_index`** — deleted via `withRouting()` after the tenant transaction, for **both** the Zitadel sub and the argus sub (pre-tenant table, no RLS).

After the transaction, attachment blobs are deleted **best-effort** from object storage:
- Rows are already gone, so no new download grant can be issued.
- Blob content is encrypted ciphertext; without the content key (which lived only in MLS envelopes) it is unreadable.
- Backblaze B2 lifecycle rule reaps unreferenced blobs within 2 days as a backstop.
- Deletion failures are logged (`logger.warn`) but not surfaced to the caller.

> **AR-2 — backup retention carve-out.** Erasure is immediate in the **live** DB, but nightly encrypted DB backups to B2 (BKP-1) retain the pre-erasure rows until their retention window lapses. This is the standard GDPR backup-retention position: the live system honours the request at once, backups age out on their schedule and are not re-surfaced into production. See the backup retention policy in `article-30-records.md` §5.

---

## Identity erasure (passkey auth — no external IdP)

There is **no external identity provider**. OIDC/Zitadel was decommissioned (`phase-6-decommission.md`, #223); login is passkey-only (WebAuthn). The user's auth identity lives **entirely inside this database** — the `users` row plus its `webauthn_credentials` (the registered passkeys) and `auth_sessions` (refresh sessions). Deleting the `users` row cascades **both** (migrations 0034 / 0032), so erasure is self-contained and complete:

- **No external console step.** The earlier "revoke the user in the Zitadel admin console" runbook no longer applies and has been removed — there is no IdP to revoke.
- **No re-authentication path survives.** Once the row is gone, the user's passkeys (`webauthn_credentials`) and refresh sessions (`auth_sessions`) are cascade-deleted in the same transaction. A held access token still verifies until its ≤10-min TTL lapses (the accepted ST-1 residual — `session-tokens.md`), but no new session can be minted (refresh rows are gone) and no passkey can authenticate (credentials are gone).

---

## Security invariants maintained

1. **Server stays crypto-blind** — export contains only metadata, never ciphertext or content keys.
2. **No cross-tenant reads** — every DB query runs under `withTenant(tenantId)` with RLS in effect.
3. **No admin path to content** — the export endpoint is self-service only; no admin surface exposes another user's export.
4. **Deletion is scoped** — the user can only delete their own account within their own tenant.
