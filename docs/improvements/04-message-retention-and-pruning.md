# Track 4 — Message retention & ciphertext pruning (bound DB growth)

> **Status:** PROPOSED 2026-06-21. Server-side only — no client change, no `@argus/contracts` change,
> no message-behavior change. Ships as its own migration + worker PRs (slices below). Sequenced **first**
> (see [README priority](./README.md)) because it should land before production starts accumulating
> ciphertext that can never be reclaimed.

## Problem

The three ciphertext-bearing tables grow **without bound**. `messages` is append-only by design — the grant
is `select, insert` only, no `delete` ([`0007_messaging.sql:96-100`](../../apps/api/src/db/migrations/0007_messaging.sql)) —
and the same is true of `conversation_commits` ([`0023`](../../apps/api/src/db/migrations/0023_conversation_commits.sql))
and, in practice, `conversation_welcomes` ([`0012`](../../apps/api/src/db/migrations/0012_welcomes.sql)). The
server keeps every MLS ciphertext blob it has ever relayed, **forever**. There is retention for attachments
(7-day TTL, blobs reaped first), `audit_events` (90 days) and `auth_sessions`, but **none for the actual
message ciphertext** — the largest and fastest-growing data in the system.

## Why it matters

The server is a **relay, not the client's archive**: clients persist their own decrypted history locally,
sealed at rest (`docs/threat-models/message-history.md`), so the server's `messages` table is only an
offline catch-up buffer — yet that buffer is never drained. Consequences:

- **Cost & operability** — disk, backup size, and restore time all grow forever with no ceiling.
- **Privacy blast radius** — every retained ciphertext row is breach- and subpoena-surface. `metadata-exposure.md`
  already flags that ciphertext **volume / row-counts are themselves a metadata leak** that grows unbounded.
- **GDPR storage-limitation (Art. 5(1)(e))** — argus currently has *no* retention story for message content.
  This is the same latent-debt class as the F1/AR-1 finding that made unbounded `audit_events` a must-fix
  (`docs/reviews/04-metadata-privacy.md`); `messages` is the larger, ciphertext-bearing version.

## Proposed approach

**Strategy: delete-on-confirmed-delivery *plus* a hard TTL ceiling backstop.** Two independent safety
properties, each covering the other's blind spot:

- **Confirmed-delivery** reclaims the common case fast and safely: a `messages` row is reapable once
  **every current member's delivery watermark is past it** — nobody can legitimately still need it.
- **TTL ceiling** (default **90 days**) is the backstop that bounds growth even when watermarks never
  converge (a quiet or old client that never POSTs `delivered`), set generously so it only ever fires on
  genuinely-abandoned ciphertext.

**Why not one mechanism alone:** the delivery signal is **per-user, not per-device** — `conversation_receipts`
is keyed `unique (tenant_id, conversation_id, user_id)` with a single `delivered_through_*` watermark
([`0010:12-22`](../../apps/api/src/db/migrations/0010_conversation_receipts.sql)), advanced by whichever of a
user's devices acks *first* (`messaging.service.ts` `recordReceipt`). So delete-on-delivery **alone** could
reap a row a user's second, still-offline device needs — message loss; and a client that never acks would
pin the watermark and prevent all deletion. TTL **alone** is either too aggressive (breaks a legitimately
long-offline device) or too lax (barely bounds growth). Together they are safe *and* bounded. Add a short
**24h delivery-grace** so a row is never reaped the instant the last ack lands (slack for an in-flight
second device and `GET /sync` overlap).

**The other two ciphertext tables, simpler rules:**

- `conversation_commits` — **TTL ceiling only**, but **never reap the current (max) epoch's commit**: a
  long-offline device still needs the latest ratchet-advancing commit to rejoin. Reap `epoch < max(epoch)`
  and older than the ceiling.
- `conversation_welcomes` — already self-prunes on join (`consumeWelcome`); residual is stranded welcomes.
  **TTL ceiling only.** Low volume — cleanup, not the main event.

**Attachment blobs are already handled — explicitly decoupled, no new B2 logic.** Every attachment gets a
**7-day** `expires_at` at upload and `infra/cleanup/cleanup-attachments.sh` reaps the **B2 object first,
then the row** ([`cleanup-attachments.sh:4-10`](../../infra/cleanup/cleanup-attachments.sh)). 7 days ≪ the
90-day message ceiling, so blobs are gone long before their message row is reaped. Message-ciphertext
pruning and blob pruning stay deliberately separate; the blob side is authoritative.

**Reuse the established least-privilege prune pattern** (`0013_attachments_cleanup.sql`,
`0043_audit_prune_role.sql` + `infra/audit-prune/prune-audit.sh`): a `nologin nobypassrls` role with
window-scoped RLS so it can only ever see/delete past-window rows, **column-scoped SELECT on `(id, created_at)`
— never `ciphertext`**, counts-only logging, connecting over the in-container local-trust socket (no DB
password on the host). The all-current-members-delivered condition runs in the **worker's WHERE** (a join too
expensive for an RLS `USING`); the RLS policy enforces the time bounds (24h grace + 90-day ceiling) as the
fail-closed boundary.

### ⚠ Mandatory PR #262 fix (verified — not cosmetic)

The tenant-isolation policies on all three target tables are currently **PUBLIC** (no `TO` clause):
`messages_tenant_isolation` ([`0007:86`](../../apps/api/src/db/migrations/0007_messaging.sql)),
`commits_tenant_isolation` ([`0023:36`](../../apps/api/src/db/migrations/0023_conversation_commits.sql)),
`conversation_welcomes_tenant_isolation` ([`0012:50`](../../apps/api/src/db/migrations/0012_welcomes.sql)) —
unlike `audit_events`/`auth_sessions`, whose policies were correctly re-scoped `TO argus_app` in `0043`.
A new prune role's window policy **OR-combines** with a PUBLIC isolation policy, so the role could
`set_config('app.tenant_id', <victim>)` and get a **live-row bypass**. The Track-04 migration **must**
re-scope each isolation policy `TO argus_app`, and an RLS spec must assert the prune role cannot read or
delete an in-window row even after setting a tenant GUC. (This is exactly the bypass Codex caught on #262.)

### Implementation slices (safety boundary lands before any deletion)

1. **Threat-model note first (no code)** — `docs/threat-models/message-retention.md` via `/feature-threat-model`;
   verify the 6 invariants; `security-architect` sign-off on the rule + the #262 re-scope.
2. **Migration: role + `TO argus_app` re-scope + window policies + `created_at` indexes** (the boundary, no
   deletion yet) + RLS spec incl. the #262 regression test. Gates: `/db-migration`, `security-boundary-auditor`,
   live-DB RLS tests in CI.
3. **Worker (TTL-only first)** — `infra/retention/prune-messages.sh` + systemd `service`/`timer`, modeled on
   `infra/audit-prune/`; counts-only logging, fail-closed, batched with a max-rounds cap. Gates:
   `infra-reviewer`, shellcheck, dry-run against a disposable DB.
4. **Add the delivery-confirmed path** — extend the worker SQL with the all-current-members-delivered join.
   Gate: `security-boundary-auditor` (the join can't widen visibility beyond the grace window).
5. **Extend to `conversation_commits` + `conversation_welcomes`** (same role; current-epoch/latest-material
   preserved).
6. **(Optional, separable) metadata-table sweepers** — see below; own PR or deferred.

> **Do not collapse slices 2 and 3:** the boundary migration must be reviewed and merged before any worker
> can delete, so a boundary bug can never ship alongside live deletion.

## Files & tables touched

- New migration `00NN_message_retention_role.sql`: create the prune role; **re-scope** the three isolation
  policies `TO argus_app`; window-scoped `for select`/`for delete` policies; **column-scoped SELECT on
  `(id, created_at)`**; plain `created_at` btree index per table (existing indexes are tenant-leading and
  can't serve a cross-tenant age scan — the same gap `0043` noted); grant DELETE.
- New worker `infra/retention/prune-messages.sh` + `argus-message-retention.{service,timer}`.
- `infra/stack/deploy/deploy.sh`: grant the new role LOGIN with a NULL password out-of-band + install the
  timer (mirror the existing prune/cleanup wiring).
- New `docs/threat-models/message-retention.md`.
- **No `apps/api` code change for the server path; no `@argus/contracts`; no client.**

## Other prunable data classes (slice 6 / follow-ups)

| Class | Recommendation | Safe signal |
| --- | --- | --- |
| `device_enrollments` | Prune resolved/expired rows (schema says "GC'd externally" but no worker exists) | `status != 'pending' AND coalesce(resolved_at, expires_at) < now() - 30d` |
| `webauthn_challenges` | Add a sweeper for abandoned ceremonies (delete-on-use is primary) | `expires_at < now()` |
| `key_packages` | Prune spent one-time packages (never reused once claimed) | `claimed_at is not null AND claimed_at < now() - 30d` |
| `stripe_events` | Low priority; schema explicitly defers | `created_at < now() - 365d` |

**MUST NOT be auto-pruned:** accepted `friendships` (the durable social graph); `conversation_members`
(deleting a member is a deliberate membership op that cascade-deletes receipts/welcomes); `conversations`
(deleting one cascades into all its messages); `audit_events` inside the 90-day Art. 30 window; the
current-epoch commit / latest welcome material (needed for a long-offline device to rejoin).

## Risks & what could break

- **Reaping a row a long-offline device still needs** → mitigated by the all-members-delivered gate + 24h
  grace + 90-day ceiling. Residual: a device offline **>90 days** misses old history it never received — the
  accepted disappearing-history trade `message-history.md` already anticipates ("A future retention policy
  can prune"). Document in product copy / DPA; do not engineer around it.
- **PR #262 OR-combine bypass if the re-scope is forgotten** → mandatory RLS regression spec (above).
- **Crypto-blind boundary** → the worker selects `(id, created_at)` only, never `ciphertext`; column-scoped
  grant enforces it even with a leaked credential. Logs are **counts only**, no row ids (these rows are
  ciphertext-bearing — follow `prune-audit.sh` discipline, not the id-logging attachment worker).
- **GDPR-erasure interaction** → erasure nulls `sender_user_id` as `argus_app`; retention deletes whole rows
  as the window-scoped prune role. Complementary, non-overlapping grants — neither widens the other.
- **Backups** → reaped rows still live in pre-reap backups (acceptable; same as audit prune today).

## How to verify by hand

1. Seed two test conversations; in one, have all members POST `delivered` watermarks past the messages.
   Run the worker → those rows are gone, the other conversation's recent rows remain.
2. Set a tiny test TTL → rows older than it disappear even with **no** receipts (backstop works).
3. As the prune role, `SET app.tenant_id` to a victim tenant and try to read/delete a *fresh* message →
   must return nothing / be denied (the #262 assertion).
4. An online, caught-up client's chat history is **unchanged** after a sweep (it reads its local sealed log).

## Out of scope

Disappearing-messages as a *user-facing* feature (this is operator-side retention, not per-conversation TTL
UX); a client "older messages may be unavailable" affordance; message padding / sealed-sender; partitioning
`messages` (a scale follow-up if volume ever demands it — `pg_partman` is not in the stack today).
