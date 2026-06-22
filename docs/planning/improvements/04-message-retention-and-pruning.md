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
is `select, insert` only, no `delete` ([`0007_messaging.sql:96-100`](../../../apps/api/src/db/migrations/0007_messaging.sql)) —
and the same is true of `conversation_commits` ([`0023`](../../../apps/api/src/db/migrations/0023_conversation_commits.sql))
and, in practice, `conversation_welcomes` ([`0012`](../../../apps/api/src/db/migrations/0012_welcomes.sql)). The
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
([`0010:12-22`](../../../apps/api/src/db/migrations/0010_conversation_receipts.sql)), advanced by whichever of a
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
([`messaging.service.ts:616-622`](../../../apps/api/src/messaging/messaging.service.ts),
[`useConversationBackfill.ts:203-210`](../../../apps/web/src/features/chat/useConversationBackfill.ts)) — so if a
quiet conversation's last-seen message ages past the TTL and is pruned, even a *briefly*-offline device can
stop seeing newer retained messages until a reload. This cannot be fixed server-side alone: `after` is a bare
**message UUID** ([`messaging.schemas.ts:23-25`](../../../apps/api/src/messaging/messaging.schemas.ts)) and the
row that carried its `created_at` is exactly what pruning removes — so nothing remains to locate
"nearest-newer" from (Codex P2). **Before TTL deletion is enabled**, pick one: (a) a **position-carrying
cursor** — make `after` an opaque `(created_at, id)` token so the position survives the anchor's deletion (a
small, backward-compatible cursor-shape change to `ListMessagesQuery`); or (b) a **retained-window fallback** —
when the anchor is unknown/pruned, restart paging from the oldest retained message. Recommended: (a). Either
way this is a real (if small) change touching `apps/api` *and* the query schema — so v1 is *not* zero-code —
and it is the first slice.

**The other ciphertext tables:**

- `conversation_commits` — **TTL ceiling only, contiguity-preserving (Codex P2).** A catching-up device
  drains commits *in epoch order* and must `processCommit()` each one to advance, so deleting an intermediate
  `epoch < max(epoch)` row strands a device at an older epoch (it cannot apply a later commit — not merely
  "missing old history"). Reap only the **oldest contiguous prefix** of commits older than the ceiling,
  **never leaving a gap**, and **always keep the current epoch — DB-enforced in the delete policy, not just
  the worker** (deleting the per-conversation max-epoch row would let a stale/retried commit reuse that epoch
  and fork MLS history; see the slice-5 migration). **There is no existing recovery path (Codex
  P2):** today `drainCommits` logs an unprocessable commit and returns, and the catch-up loop silently retries
  without noticing the epoch never advanced
  ([`messaging.ts:288-301`](../../../apps/web/src/lib/messaging.ts),
  [`useLiveConversations.ts:447-457`](../../../apps/web/src/features/chat/useLiveConversations.ts)) — so a device
  behind the first retained epoch would **spin / stay stuck**, not re-invite. Commit pruning therefore carries
  its own prerequisite: build an **explicit missing-commit / sync-lost signal** (detect the gap → surface
  re-invite) *before* enabling it. Until that exists, do not prune commits.
- `conversation_welcomes` — **excluded from pruning in this track (Codex P2).** Consume = DELETE the row (no
  `consumed_at` column — [`0012:60`](../../../apps/api/src/db/migrations/0012_welcomes.sql)), so *every* row still
  present is **unconsumed**: the only HPKE-sealed Welcome/RatchetTree an added-while-offline device can use to
  join. There is no "safely stale" welcome to TTL-prune, so the prune role gets **no grant/policy on this
  table**. Deferred until a missing-welcome / re-invite recovery path exists (then prune only welcomes
  superseded by a newer one, or for departed devices). Low volume regardless.

**Attachment blobs are already handled — explicitly decoupled, no new B2 logic.** Every attachment gets a
**7-day** `expires_at` at upload and `infra/cleanup/cleanup-attachments.sh` reaps the **B2 object first,
then the row** ([`cleanup-attachments.sh:4-10`](../../../infra/cleanup/cleanup-attachments.sh)). 7 days ≪ the
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

The tenant-isolation policies on the **pruned** tables are currently **PUBLIC** (no `TO` clause):
`messages_tenant_isolation` ([`0007:86`](../../../apps/api/src/db/migrations/0007_messaging.sql)) and
`commits_tenant_isolation` ([`0023:36`](../../../apps/api/src/db/migrations/0023_conversation_commits.sql)) —
unlike `audit_events`/`auth_sessions`, whose policies were correctly re-scoped `TO argus_app` in `0043`.
A new prune role's window policy **OR-combines** with a PUBLIC isolation policy, so the role could
`set_config('app.tenant_id', <victim>)` and get a **live-row bypass**. Each table's re-scope lands **in the
same migration that first gives the prune role a policy over it** — `messages` in the boundary migration
(slice 3), `conversation_commits` in the commit-prune migration (slice 5) — never ahead of need; each ships
with an RLS spec asserting the prune role cannot read or delete an in-window row even after setting a tenant
GUC. (This is exactly the bypass Codex caught on #262.) `conversation_welcomes` is not pruned here, so its
policy is left untouched until welcome
pruning is implemented.

### Implementation slices (safety boundary lands before any deletion)

1. **✅ Prune-safe catch-up cursor (no deletion)** — make `after` / `MessagePage.nextCursor` a position-carrying
   `(created_at, id)` token across `@argus/contracts` + `apps/api` + web response validation + OpenAPI (or add
   the retained-window fallback) so backfill survives a pruned anchor (prerequisite above). **Cached-PWA-safe
   rollout (Codex P2):** old bundles validate `nextCursor` as `z.string().uuid()`, so an opaque token breaks
   their paging until they update — so do *not* swap it in place. Use a new field (e.g. `nextCursorV2`) **or**
   gate the opaque cursor behind a client capability flag (the existing `default=false` opt-in pattern at
   `messaging.schemas.ts:15`), keeping the UUID `nextCursor` valid for old clients; only enable TTL deletion
   after the client side is adopted. Gates: `security-boundary-auditor`, a `listMessages` anchor-pruned cursor
   test + web response test + a stale-PWA-compat test.

   > **Implemented 2026-06-21 ([#289](https://github.com/Dezoxy/secmes/pull/289)).** Instantiated the "new field" as a **per-message opaque
   > `cursor`** on `FetchedMessage` (not a page-level `nextCursorV2`), reusing the proven `/sync`
   > `encodeKeysetCursor` (microsecond `(created_at, id)`, base64url). The client echoes it as `after`;
   > it never builds a cursor itself (no format coupling, no ms-truncation footgun). **Why per-message:** the
   > web backfill's stored resume anchor is a *single message's* position — set mid-page at MLS epoch breaks
   > and at the caught-up partial-page end ([`messaging.ts`](../../../apps/web/src/lib/messaging.ts)), not just
   > at page boundaries — so only a per-message cursor makes *every* held resume point prune-safe. The legacy
   > UUID `nextCursor` and a legacy bare-id `after` are both still accepted (server discriminates by UUID
   > shape → legacy anchor-lookup vs opaque → keyset). No DB/RLS/migration, no envelope change.
2. **✅ Threat-model note (no code)** — `docs/threat-models/message-retention.md` via `/feature-threat-model`;
   verify the 6 invariants; `security-architect` sign-off on the rule + the #262 re-scope.

   > **Implemented 2026-06-21 ([#290](https://github.com/Dezoxy/secmes/pull/290)).** Wrote [`docs/threat-models/message-retention.md`](../../threat-models/message-retention.md)
   > (6-section structure, all 6 invariants checked). Both reviewers **PASS_WITH_CONDITIONS** — the design is
   > validated against the code; every condition is binding on the **code** slices (3/4/5) and is recorded in
   > the note's §7 + here. Gaps the sign-off surfaced for those slices: (a) **slice 3** — the `0007`
   > `messages_tenant_isolation` policy *throws* on an unset GUC (the prune role's normal state), so the
   > re-scope must use the `0043` `TO argus_app` form and the RLS spec must assert BOTH the GUC-set bypass is
   > denied AND the no-GUC sweep succeeds; (b) **slice 4** — use a **dedicated** prune role (e.g.
   > `argus_msg_prune`), with `deploy.sh` LOGIN-NULL + a connectivity probe; (c) **slice 5** — the
   > never-current-epoch policy is a correlated `EXISTS (epoch > this.epoch)` backed by the existing
   > `(tenant_id, conversation_id, epoch)` index, and the worker must independently enforce
   > contiguous-prefix-only (pin `never-max-epoch` + `no-gap-left`).
3. **✅ Boundary migration — `messages` only** (no deletion yet): create the prune role; re-scope
   `messages_tenant_isolation` `TO argus_app`; messages window `for select`/`for delete` policy; messages
   `(id, created_at)` SELECT + `created_at` index; **grant DELETE on `messages` only** + the #262 regression
   spec. Gates: `/db-migration`, `security-boundary-auditor`, live-DB RLS tests in CI.

   > **Implemented 2026-06-21 ([#291](https://github.com/Dezoxy/secmes/pull/291)).** [`0044_messages_prune_role.sql`](../../../apps/api/src/db/migrations/0044_messages_prune_role.sql) —
   > a **dedicated** `argus_msg_prune` role (`nologin nobypassrls`, §7 cond 2), the `messages_tenant_isolation`
   > re-scope `TO argus_app` (the #262 fix), window-scoped `for select`/`for delete` prune policies
   > (`created_at < now() - interval '90 days'`), a **column-scoped** `grant select (id, created_at), delete`
   > (never `ciphertext`), and a plain `messages_created_at_idx` for the cross-tenant age scan — line-for-line
   > the `0043` pattern. The live-DB spec
   > [`messages-prune-rls.spec.ts`](../../../apps/api/src/db/messages-prune-rls.spec.ts) pins §7 cond 1 **both
   > ways**: the prune role's no-GUC sweep **succeeds** (would *throw* if the re-scope were wrong) AND a
   > GUC-set cross-tenant bypass is **denied**; plus past-window delete works, in-window survives, app
   > isolation is unchanged, and reading `ciphertext` is denied at the column-grant level. **No deletion** —
   > the role stays `NOLOGIN` (nothing connects as it yet); the `deploy.sh` LOGIN-NULL + connectivity probe
   > and the TTL worker are **slice 4**.
4. **Worker (TTL-only) — this is v1, the only deletion that ships in this track** —
   `infra/retention/prune-messages.sh` + systemd `service`/`timer`, modeled on `infra/audit-prune/`;
   counts-only logging, fail-closed, batched with a max-rounds cap. Gates: `infra-reviewer`, shellcheck,
   dry-run against a disposable DB.

   > **Implemented 2026-06-21 ([#292](https://github.com/Dezoxy/secmes/pull/292)).** The v1 TTL deletion now ships.
   > [`infra/retention/prune-messages.sh`](../../../infra/retention/prune-messages.sh) — a single-table clone
   > of `prune-audit.sh`: connects in-container as `argus_msg_prune` (no password), batch-deletes `messages`
   > with `created_at < now() - interval '90 days'` (the **same literal as the `0044` RLS policy** — the RLS
   > `DELETE` policy is the DB-enforced hard floor regardless), loops to `PRUNE_MAX_ROUNDS`, logs **counts
   > only** (`pruned_messages=N`, never a row id — §7 cond 5), and **fails closed** (`exit 1` → `OnFailure`
   > alert) if the DB is unreachable. Daily systemd `timer` +
   > [hardened `service`](../../../infra/retention/argus-message-retention.service) (no `LoadCredential`, no
   > egress — `AF_UNIX`/`AF_NETLINK` only, `MemoryDenyWriteExecute=true`).
   > [`deploy.sh`](../../../infra/stack/deploy/deploy.sh) wires §7 cond 2: `ALTER ROLE argus_msg_prune WITH
   > LOGIN PASSWORD NULL` out-of-band **plus a connectivity probe** that fails the deploy if the role can't
   > connect (so retention can never silently never-run). **No app code, no migration, no contract change.**
   > `conversation_commits` pruning (slice 5) stays deferred — no `DELETE` grant on it exists.
5. **Extend to `conversation_commits` — re-sliced (the original slice 5).** A `security-architect` design pass
   (2026-06-21) confirmed the gating recovery signal does not exist **and** that a device behind the oldest
   *retained* commit epoch spins forever **today** (`drainCommits` stops at the first unprocessable commit and
   the catch-up loop silently retries) — a latent bug, independent of pruning. The MLS-correct recovery is
   **re-add by an existing member via a fresh Welcome** (reuse the existing `enrollDevice` /
   `joinConversationFromPool` path), **not** MLS external-commit (new crypto surface, weaker device trust). So
   the tail is split into the prerequisite — built now — and the deferred pruning:
   - **5a — server: expose the oldest retained commit epoch** (read-only header; no deletion/migration).
   - **5b — client: detect "sync-lost"** (the drain reports advance/stall; a true gap is `oldestRetainedEpoch
     > localEpoch`, distinguished from a transient stall with a bounded retry budget).
   - **5c — sync-lost → an honest UI affordance (detect + stop).** A `security-architect` pass plus the
     Codex review (2026-06-21) found the originally-planned *recovery action* **unimplementable** in v1:
     `onSyncLost` fires only on the *stranded* device, no cross-device "I'm stranded" signal exists (adding
     one is the published-GroupInfo server surface the threat model rules out), `conversation_members` is
     per-*user* so a live sibling can't see a stale leaf, and **nothing produces a fresh Welcome for an
     already-rostered device** (`enrollDevice` skips members already in the roster; replacing a stale leaf
     needs the unbuilt MLS remove+add/PCS path). Clearing durable state + re-driving the Welcome drain in
     v1 would therefore be a premature half-mechanism (it lists nothing, and the delete races a concurrent
     ratchet save). So 5c is scoped to its honest standalone half: **drop the doomed group from the
     in-memory live set** (the live paths stop attempting a ratchet that can't advance) and **surface an
     "out of sync" banner + suppress the composer**, and **durably mark the conversation sync-lost** (a
     `syncLost` flag on the stored group state, mirroring `creatorId` — preserved across ratchet saves,
     never a destructive delete) so a reload re-surfaces the banner and keeps the stale group **out of the
     live set** (otherwise a refresh would rehydrate it as live and a stale-epoch send would be
     undecryptable). Client-only; no server/crypto surface.
   - **5c-2 (deferred) — the recovery mechanism: re-add via the member/Welcome path.** The whole active
     recovery — clear the broken durable state and re-establish the conversation so the device re-joins
     **fresh** (full out-of-band safety-number re-check, fresh KeyPackage) — lands together here. It needs
     either new server state (the cross-device "stranded" signal / published-GroupInfo surface the threat
     model rules out) or the MLS remove+add (PCS) path the crypto wrapper does not yet implement. Un-defer
     with group-chat GA (same trigger as 5d–5e).
   - **5d (deferred) — commit-prune boundary migration**: re-scope `commits_tenant_isolation` `TO argus_app`,
     window policies, the correlated `EXISTS (epoch > this.epoch)` never-current-epoch DELETE policy,
     column-scoped grant (never the `commit` blob), **first DELETE grant on commits** (§7 cond 3/4).
   - **5e (deferred) — contiguity-preserving worker**: oldest contiguous prefix only, never a gap, never the
     current epoch; counts-only, fail-closed.
   - **Why 5d–5e are deferred:** 1:1 conversations write **zero** commit rows; only group chat does, slowly —
     commit pruning is premature at current scale. Un-defer when group chat is GA / commit growth is
     measurable. `conversation_welcomes` stays **excluded** (every row is unconsumed; needs a re-invite path).

   > **Slice 5a implemented 2026-06-21 (PR _pending_).** `listCommits`
   > ([`message-delivery.service.ts`](../../../apps/api/src/messaging/message-delivery.service.ts)) now also
   > returns the oldest retained commit epoch — `min(epoch)` over the **whole** conversation (no `afterEpoch`
   > filter), computed in the **same RLS-scoped transaction** after `requireMembership`, **metadata only,
   > never the `commit` blob** (invariant #1). It is surfaced on `GET …/commits` as the
   > **`X-Oldest-Retained-Epoch`** response header (the shared `OLDEST_RETAINED_EPOCH_HEADER` contract
   > constant) — a header, **not** a body field, so stale PWAs that validate the body as a bare
   > `FetchedCommit[]` (`CommitPageSchema`) keep working; updated clients read it (5b) to tell a transient
   > stall from a pruned/lost gap. No deletion, no migration, no body-shape change. Gates: controller spec
   > (header set/omitted), a live-DB test (`min(epoch)` independent of `afterEpoch`, `null` when empty),
   > `security-boundary-auditor`, regenerated OpenAPI + 42Crunch.

   > **Slice 5b implemented 2026-06-21 ([#296](https://github.com/Dezoxy/secmes/pull/296)).** Client-only; no server, contract, or wire change.
   > The web client now **detects** a stranded conversation instead of spinning on it:
   > - [`listCommits`](../../../apps/web/src/lib/api.ts) reads the 5a `X-Oldest-Retained-Epoch` header (via a
   >   new, body-agnostic `onResponse` header tap in
   >   [`api-client.ts`](../../../apps/web/src/lib/api-client.ts)) and returns
   >   `{ commits, oldestRetainedEpoch }`.
   > - [`drainCommits` / `processCommitEvent`](../../../apps/web/src/lib/messaging.ts) now return a
   >   `CommitDrainResult` (`advanced`, `stoppedReason`, `oldestRetainedEpoch`) instead of `void` — the
   >   forward-secrecy `maxEpoch` ceiling is unchanged.
   > - A pure, unit-tested `classifyCommitDrain`
   >   ([`useLiveConversations.ts`](../../../apps/web/src/features/chat/useLiveConversations.ts)) turns a
   >   non-advancing drain into `transient` (retry) vs **`sync-lost`** — the latter exactly when the commit
   >   that would advance the group (the one stamped at the local epoch) has been pruned
   >   (`oldestRetainedEpoch > localEpoch`).
   > - The catch-up loop + `onCommit` handler escalate a genuine gap to a new optional `onSyncLost`
   >   callback (recovery + UI are 5c) and otherwise retry within a **bounded budget** — closing the
   >   spin-forever latent bug. The epoch is metadata only; it never gates decryption or ordering. Gates:
   >   unit tests (classifier table + drain-result contract + the 5a↔5b header seam), `crypto-reviewer`
   >   (epoch-overshoot discipline preserved).

   > **Slice 5c implemented 2026-06-21 (PR _pending_).** Client-only; no server, contract, migration, or
   > wire change. The honest standalone half of recovery — surface the `sync-lost` state 5b detects and
   > stop attempting it (the recovery *action* is deferred to 5c-2; see the bullets above for why it's
   > unimplementable in v1):
   > - [`useLiveConversations`](../../../apps/web/src/features/chat/useLiveConversations.ts) wires its three
   >   `sync-lost` fire sites through one `signalSyncLost`, which **drops the doomed group from the
   >   in-memory `liveGroups`** (so the catch-up / commit-drain / live-message paths stop attempting a
   >   ratchet that can't advance — idempotent across all three via their `if (!group) return` guard) and
   >   calls `onSyncLost?.()` (the UI signal), and **durably marks the conversation sync-lost** via a new
   >   `keystore.markConversationSyncLost` (a `syncLost` flag on the stored group state, mirroring
   >   `creatorId` — preserved across ratchet saves, so an in-flight save can't drop it; never a delete, so
   >   nothing to race). Rehydration reads `getSyncLostConversationIds` and rebuilds such conversations
   >   into the list **without making them live** + stamps the banner — so a reload keeps the honest state
   >   and a stale-epoch send can't go out. The `maxEpoch` discipline is untouched.
   > - [`ChatScreen`](../../../apps/web/src/features/chat/ChatScreen.tsx) stamps a `recovery: 'sync-lost'`
   >   flag on the conversation (`Conversation` type, [`seed.ts`](../../../apps/web/src/features/chat/seed.ts))
   >   and renders a "Conversation out of sync" banner ("…fell too far behind to sync. New messages may not
   >   appear and older ones may be unavailable.") + suppresses the composer. The copy makes **no** promise
   >   of automatic reconnection — re-establishment is 5c-2.
   > - Gates: an E2E guard (no affordance on a healthy chat) + a documented skip for the backend-dependent
   >   sync-lost→recovered flow; `crypto-reviewer` + `security-boundary-auditor`. The detection itself stays
   >   covered by 5b's `classifyCommitDrain` unit tests.
6. **(Optional, separable) metadata-table sweepers** — see below; own PR or deferred.
7. **(Future, prerequisite-gated) delivery-confirmed pruning** — *only after per-device delivery tracking
   exists* (Codex P1). Extends the worker join + the role's metadata grants. **Not part of this track's
   shipped scope** — listed so the design is complete.

> **Do not collapse slices 3 and 4:** the boundary migration must be reviewed and merged before any worker
> can delete, so a boundary bug can never ship alongside live deletion.

## Files & tables touched

- **Boundary migration `00NN_message_retention_role.sql` (slice 3, `messages` only):** create the prune role;
  re-scope `messages_tenant_isolation` `TO argus_app`; messages window `for select`/`for delete` policy;
  **column-scoped SELECT `messages (id, created_at)` — never `ciphertext`**; plain `created_at` btree index
  (the existing indexes are tenant-leading and can't serve a cross-tenant age scan — the same gap `0043`
  noted); **grant DELETE on `messages` only**.
- **Commit-prune migration (slice 5, gated on the recovery signal):** re-scope `commits_tenant_isolation`
  `TO argus_app`; a commit `for delete` policy that is time-windowed **and DB-enforces "never the current
  epoch" (Codex P2)** — its `USING` must require a newer commit to exist in the same conversation (a
  correlated `EXISTS (… epoch > this.epoch)`) or run behind a `security definer` function, so deleting the
  per-conversation max/current row is impossible **even if the worker query is wrong** (otherwise a later
  stale / retried commit could reuse that epoch and fork MLS history, since `postCommit` derives the next
  epoch from `max(epoch)`); SELECT `conversation_commits (id, created_at, conversation_id, epoch)` for that
  predicate; `created_at` index; **grant DELETE on `conversation_commits` here — not earlier** (note the
  correlated-`EXISTS` perf trade-off for `security-boundary-auditor` to weigh). `conversation_welcomes` gets
  no role / grant / policy in this track.
- New worker `infra/retention/prune-messages.sh` + `argus-message-retention.{service,timer}`.
- `infra/stack/deploy/deploy.sh`: grant the new role LOGIN with a NULL password out-of-band + install the
  timer (mirror the existing prune/cleanup wiring).
- New `docs/threat-models/message-retention.md`.
- **The position-carrying cursor spans the shared contract (slice 1), not just `apps/api` (Codex P2):**
  `ListMessagesQuerySchema.after` *and* `MessagePage.nextCursor` (today a UUID at
  [`contracts/src/index.ts:345`](../../../packages/contracts/src/index.ts)), the web response validation +
  tests ([`apps/web/src/lib/api.ts:468`](../../../apps/web/src/lib/api.ts)), and the OpenAPI DTO format — all
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
epoch **plus the contiguous commit chain within the retained window**; and **all `conversation_welcomes`**
(consume = DELETE, so every remaining row is an unconsumed Welcome a device still needs to join — excluded
from this track entirely).

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
