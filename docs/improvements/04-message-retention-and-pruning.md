# Track 4 — Message retention & ciphertext pruning (bound DB growth)

> **Status:** PROPOSED 2026-06-21. Mostly server-side, with **gated prerequisites before any deletion**: a
> position-carrying backfill cursor (a backward-compatible shared-cursor change spanning `@argus/contracts` +
> `apps/api` + web + OpenAPI), and — for commit pruning — a client missing-commit / sync-lost signal. No
> message wire-format / envelope change. The only user-visible effect:
> ciphertext older than the retention ceiling is no longer fetchable from the server (clients keep their own
> local history). Ships as its own slices (below). Sequenced **first** (see [README priority](./README.md))
> because it should land before production starts accumulating ciphertext that can never be reclaimed.

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

**Strategy (v1): a hard TTL ceiling (default 90 days).** Every message older than the ceiling is reaped
regardless of delivery state. This bounds growth and is safe for multi-device — a device has the full 90-day
window to come back and catch up — **provided the catch-up cursor is made prune-safe first** (prerequisite
below); only a device offline *longer* than the ceiling loses history it never received, the
disappearing-history trade `message-history.md` already anticipates. The ceiling is a **single reviewed
constant shared by the RLS policy and the worker** (Codex P2) — changing it is a migration that re-issues the
policy alongside the worker setting, *not* an independent runtime knob, so the DB boundary and the worker can
never drift.

**Why *not* delete-on-confirmed-delivery in v1 (Codex P1 — verified).** A delivery gate would reclaim hot
conversations faster, but the delivery signal today is **per-user, not per-device**: `conversation_receipts`
is keyed `unique (tenant_id, conversation_id, user_id)` with a single `delivered_through_*` watermark
([`0010:12-22`](../../apps/api/src/db/migrations/0010_conversation_receipts.sql)), advanced by whichever of a
user's devices acks *first* (`recordReceipt`), and `GET /sync` is likewise user-scoped. So if device D1 is
online and D2 is offline for longer than any short grace but less than the TTL, **every** member's watermark
can pass a message and the worker would delete the only server-side ciphertext D2 can still fetch — a silent
message-loss / behavior change. A grace window does not fix this (D2 can be offline for days). **Therefore
delivery-confirmed pruning is deferred** until delivery is tracked **per device** (a schema + client change —
see Out of scope). Until then the TTL ceiling is the sole, safe mechanism and no client/contract change is
needed.

**Prerequisite — make the catch-up cursor prune-safe (Codex P2).** The full-window guarantee assumes a
returning device can page in everything newer than where it left off. Today the web reconnect path backfills
per conversation via `listMessages` with a **message-id cursor**, and that SQL returns an *empty* page when
the cursor's anchor row no longer exists
([`messaging.service.ts:616-622`](../../apps/api/src/messaging/messaging.service.ts),
[`useConversationBackfill.ts:203-210`](../../apps/web/src/features/chat/useConversationBackfill.ts)) — so if a
quiet conversation's last-seen message ages past the TTL and is pruned, even a *briefly*-offline device can
stop seeing newer retained messages until a reload. This cannot be fixed server-side alone: `after` is a bare
**message UUID** ([`messaging.schemas.ts:23-25`](../../apps/api/src/messaging/messaging.schemas.ts)) and the
row that carried its `created_at` is exactly what pruning removes — so nothing remains to locate
"nearest-newer" from (Codex P2). **Before TTL deletion is enabled**, pick one: (a) a **position-carrying
cursor** — make `after` an opaque `(created_at, id)` token so the position survives the anchor's deletion (a
small, backward-compatible cursor-shape change to `ListMessagesQuery`); or (b) a **retained-window fallback** —
when the anchor is unknown/pruned, restart paging from the oldest retained message. Recommended: (a). Either
way this is a real (if small) change touching `apps/api` *and* the query schema — so v1 is *not* zero-code —
and it is the first slice.

**The other two ciphertext tables, simpler rules:**

- `conversation_commits` — **TTL ceiling only, contiguity-preserving (Codex P2).** A catching-up device
  drains commits *in epoch order* and must `processCommit()` each one to advance, so deleting an intermediate
  `epoch < max(epoch)` row strands a device at an older epoch (it cannot apply a later commit — not merely
  "missing old history"). Reap only the **oldest contiguous prefix** of commits older than the ceiling,
  **never leaving a gap**, and **always keep the current epoch**. **There is no existing recovery path (Codex
  P2):** today `drainCommits` logs an unprocessable commit and returns, and the catch-up loop silently retries
  without noticing the epoch never advanced
  ([`messaging.ts:288-301`](../../apps/web/src/lib/messaging.ts),
  [`useLiveConversations.ts:447-457`](../../apps/web/src/features/chat/useLiveConversations.ts)) — so a device
  behind the first retained epoch would **spin / stay stuck**, not re-invite. Commit pruning therefore carries
  its own prerequisite: build an **explicit missing-commit / sync-lost signal** (detect the gap → surface
  re-invite) *before* enabling it. Until that exists, do not prune commits.
- `conversation_welcomes` — already self-prunes on join (`consumeWelcome`); residual is stranded welcomes.
  **TTL ceiling only.** Low volume — cleanup, not the main event.

**Attachment blobs are already handled — explicitly decoupled, no new B2 logic.** Every attachment gets a
**7-day** `expires_at` at upload and `infra/cleanup/cleanup-attachments.sh` reaps the **B2 object first,
then the row** ([`cleanup-attachments.sh:4-10`](../../infra/cleanup/cleanup-attachments.sh)). 7 days ≪ the
90-day message ceiling, so blobs are gone long before their message row is reaped. Message-ciphertext
pruning and blob pruning stay deliberately separate; the blob side is authoritative.

**Reuse the established least-privilege prune pattern** (`0013_attachments_cleanup.sql`,
`0043_audit_prune_role.sql` + `infra/audit-prune/prune-audit.sh`): a `nologin nobypassrls` role with
window-scoped RLS so it can only ever see/delete past-window rows, counts-only logging, connecting over the
in-container local-trust socket (no DB password on the host). The role reads **non-content metadata only —
never `ciphertext` / `commit` / `welcome` blobs**: `messages (id, created_at)`, and `conversation_commits
(id, created_at, conversation_id, epoch)` for the contiguity rule (see grants below). The RLS policy enforces
the time bound as the fail-closed boundary — and **its window is derived from the same reviewed ceiling
constant as the worker** (Codex P2), so the policy and the worker can never disagree on what is reapable.

**The grant must cover every column *and table* the predicate reads (Codex P2).** PostgreSQL requires SELECT
privilege on all columns/tables referenced in a DELETE `USING`/predicate, not just the deleted row. The TTL
predicate reads only `messages.(id, created_at)`, so v1 is fully covered. The deferred delivery-confirmed
path (above) would join `messages.conversation_id` against `conversation_members` / `conversation_receipts`
watermarks — so it must *additionally* grant the role SELECT on **those non-content metadata columns/tables**
(never `ciphertext`), or move the predicate behind a reviewed `security definer` function. The migration for
that future path must spell out the exact grants, or the role simply fails the join.

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

1. **Prune-safe catch-up cursor (no deletion)** — make `after` / `MessagePage.nextCursor` a position-carrying
   `(created_at, id)` token across `@argus/contracts` + `apps/api` + web response validation + OpenAPI (or add
   the retained-window fallback), backward-compatibly, so backfill survives a pruned anchor (prerequisite
   above). Gates: `security-boundary-auditor`, a `listMessages` anchor-pruned cursor test + web response test.
2. **Threat-model note (no code)** — `docs/threat-models/message-retention.md` via `/feature-threat-model`;
   verify the 6 invariants; `security-architect` sign-off on the rule + the #262 re-scope.
3. **Migration: role + `TO argus_app` re-scope + window policies + `created_at` indexes** (the boundary, no
   deletion yet) + RLS spec incl. the #262 regression test. Gates: `/db-migration`, `security-boundary-auditor`,
   live-DB RLS tests in CI.
4. **Worker (TTL-only) — this is v1, the only deletion that ships in this track** —
   `infra/retention/prune-messages.sh` + systemd `service`/`timer`, modeled on `infra/audit-prune/`;
   counts-only logging, fail-closed, batched with a max-rounds cap. Gates: `infra-reviewer`, shellcheck,
   dry-run against a disposable DB.
5. **Extend to `conversation_commits` + `conversation_welcomes`** (same role; contiguity-preserving commit
   reap with the current epoch always kept; welcomes TTL). **Gated on** the client missing-commit / sync-lost
   signal (build it first, or do not prune commits — Codex P2).
6. **(Optional, separable) metadata-table sweepers** — see below; own PR or deferred.
7. **(Future, prerequisite-gated) delivery-confirmed pruning** — *only after per-device delivery tracking
   exists* (Codex P1). Extends the worker join + the role's metadata grants. **Not part of this track's
   shipped scope** — listed so the design is complete.

> **Do not collapse slices 3 and 4:** the boundary migration must be reviewed and merged before any worker
> can delete, so a boundary bug can never ship alongside live deletion.

## Files & tables touched

- New migration `00NN_message_retention_role.sql`: create the prune role; **re-scope** the three isolation
  policies `TO argus_app`; window-scoped `for select`/`for delete` policies; **column-scoped SELECT matched to
  each table's predicate** — `messages (id, created_at)`, `conversation_welcomes (id, created_at)`, and
  **`conversation_commits (id, created_at, conversation_id, epoch)`** so the contiguity / keep-current-epoch
  rule can actually run (Codex P2) — **never `ciphertext` / `commit` / `welcome` / `ratchet_tree`**; plain
  `created_at` btree index per table (existing indexes are tenant-leading and can't serve a cross-tenant age
  scan — the same gap `0043` noted); grant DELETE.
- New worker `infra/retention/prune-messages.sh` + `argus-message-retention.{service,timer}`.
- `infra/stack/deploy/deploy.sh`: grant the new role LOGIN with a NULL password out-of-band + install the
  timer (mirror the existing prune/cleanup wiring).
- New `docs/threat-models/message-retention.md`.
- **The position-carrying cursor spans the shared contract (slice 1), not just `apps/api` (Codex P2):**
  `ListMessagesQuerySchema.after` *and* `MessagePage.nextCursor` (today a UUID at
  [`contracts/src/index.ts:345`](../../packages/contracts/src/index.ts)), the web response validation +
  tests ([`apps/web/src/lib/api.ts:468`](../../apps/web/src/lib/api.ts)), and the OpenAPI DTO format — all
  updated together, backward-compatibly, or the PWA rejects any page carrying the new cursor. (The
  `syncMessages` path already uses an opaque encoded cursor — `messaging.schemas.ts:32-35` — so this aligns
  `listMessages` with an existing pattern.) Commit pruning additionally needs a **client** missing-commit /
  sync-lost signal (prerequisite to slice 5). No message wire-format / envelope change.

## Other prunable data classes (slice 5 / follow-ups)

| Class | Recommendation | Safe signal |
| --- | --- | --- |
| `device_enrollments` | Prune resolved rows **and abandoned-pending rows** (schema says "GC'd externally" but no worker exists; pending auto-expires after 15 min) | `(status != 'pending' AND coalesce(resolved_at, expires_at) < now() - 30d) OR (status = 'pending' AND expires_at < now())` |
| `webauthn_challenges` | Add a sweeper for abandoned ceremonies (delete-on-use is primary) | `expires_at < now()` |
| `key_packages` | Prune spent one-time packages (never reused once claimed) | `claimed_at is not null AND claimed_at < now() - 30d` |
| `stripe_events` | Low priority; schema explicitly defers | `received_at < now() - 365d` |

**MUST NOT be auto-pruned:** accepted `friendships` (the durable social graph); `conversation_members`
(deleting a member is a deliberate membership op that cascade-deletes receipts/welcomes); `conversations`
(deleting one cascades into all its messages); `audit_events` inside the 90-day Art. 30 window; the current
epoch **plus the contiguous commit chain within the retained window**, and the latest welcome material
(needed for a long-offline device to rejoin).

## Risks & what could break

- **Reaping a row a device offline within the window still needs** → v1 has *no* delivery gate, so the full
  90-day ceiling is the guarantee: any device that returns within 90 days catches up via the **prune-safe
  backfill cursor** (slice 1). Residual: a device offline **>90 days** misses old history it never received — the accepted
  disappearing-history trade `message-history.md` already anticipates ("A future retention policy can prune").
  Document in product copy / DPA; do not engineer around it. The riskier delivery-confirmed gate is deferred
  behind a per-device-tracking prerequisite (Codex P1), so v1 cannot drop a second device's backlog.
- **PR #262 OR-combine bypass if the re-scope is forgotten** → mandatory RLS regression spec (above).
- **Crypto-blind boundary** → the worker selects **non-content metadata only** (`(id, created_at)`, plus
  `(conversation_id, epoch)` for commits), never `ciphertext` / `commit` / `welcome` blobs; the column-scoped
  grant enforces it even with a leaked credential. Logs are **counts only**, no row ids (these rows are
  ciphertext-bearing — follow `prune-audit.sh` discipline, not the id-logging attachment worker).
- **GDPR-erasure interaction** → erasure nulls `sender_user_id` as `argus_app`; retention deletes whole rows
  as the window-scoped prune role. Complementary, non-overlapping grants — neither widens the other.
- **Backups** → reaped rows still live in pre-reap backups (acceptable; same as audit prune today).

## How to verify by hand

1. Seed messages with a tiny test TTL; run the worker → only rows older than the TTL disappear, newer rows
   remain (the v1 mechanism).
2. **Prune-safe cursor:** in a quiet conversation, prune the exact message a device's saved cursor points at,
   then reconnect that device → backfill still returns the **newer** retained messages, not an empty page
   (Codex P2 — the slice-1 prerequisite).
3. Multi-device check: a user whose second device has been "offline" past any grace but inside the TTL → its
   messages are **still present** after a sweep (v1 has no delivery gate, so no second-device loss — Codex P1).
4. As the prune role, `SET app.tenant_id` to a victim tenant and try to read/delete an *in-window* message →
   must return nothing / be denied (the #262 assertion).
5. An online, caught-up client's chat history is **unchanged** after a sweep (it reads its local sealed log).

## Out of scope

**Per-device delivery tracking** — the schema + client change that would make delivery-confirmed pruning safe;
until it exists, retention is TTL-only (Codex P1). Disappearing-messages as a *user-facing* feature (this is
operator-side retention, not per-conversation TTL UX); a client "older messages may be unavailable"
affordance; message padding / sealed-sender; partitioning `messages` (a scale follow-up if volume ever
demands it — `pg_partman` is not in the stack today).
