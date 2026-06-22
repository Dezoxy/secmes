# Threat model: message retention & ciphertext pruning

> Status: **DRAFT for ratification.** Improvement **Track 4** — bound unbounded growth of the ciphertext
> tables by reaping rows past a hard **TTL ceiling (default 90 days)**. This is **operator-side retention**,
> not a user-facing disappearing-messages feature. Scope: `messages` (slices 3–4) and — later, gated —
> `conversation_commits` (slice 5). `conversation_welcomes` is **excluded**. **No envelope / wire-format
> change.** The only user-visible effect: ciphertext older than the ceiling is no longer fetchable from the
> server; clients keep their own local sealed history (`message-history.md`). The slice-1 **prune-safe
> cursor** ([#289](https://github.com/Dezoxy/secmes/pull/289), merged) is a hard prerequisite. This note is
> written **before** the boundary migration (slice 3) and worker (slice 4); it carries a `security-architect`
> + `crypto-reviewer` sign-off (both **PASS_WITH_CONDITIONS** — §5, §7).

## 1. Feature & data flow

```
worker (systemd timer)        connects in-container via the local-trust socket — NO published port,
infra/retention/prune-…sh  →  NO DB password on the host. Assumes a least-privilege prune role
(modeled on infra/audit-prune)  (nologin nobypassrls; LOGIN PASSWORD NULL set out-of-band by deploy.sh).
                           →  DELETE messages WHERE created_at < now() - <ceiling>, batched, max-rounds cap.
                              Reads non-content metadata ONLY (id, created_at). Logs COUNTS only, no ids.
```

- **v1 deletes `messages`** older than the ceiling **regardless of delivery state** (TTL-only — see §5 for why
  not delete-on-delivery). The ceiling is **one reviewed constant shared by the RLS policy and the worker** —
  changing it is a migration that re-issues the policy, never an independent runtime knob, so the DB boundary
  and the worker cannot drift.
- **Deferred to slice 5:** `conversation_commits` — a **contiguity-preserving prefix** reap that always keeps
  the current epoch, gated on a client missing-commit / sync-lost recovery signal that does not exist today.
- **Excluded entirely:** `conversation_welcomes` — consume == DELETE (no `consumed_at`), so every row still
  present is an **unconsumed** Welcome a device still needs to join; it gets **no role, grant, or policy** here.
- The worker never decrypts and never reads `ciphertext`/`commit` blobs (column-scoped grant, §3).

## 2. Assets & trust boundaries

- **Assets:** the opaque MLS **ciphertext rows** (`messages.ciphertext`, `conversation_commits.commit` — never
  decrypted); the **deletion authority** (the prune role's `DELETE`); **tenant isolation** (the
  `app.tenant_id`-keyed RLS confining every read/delete to one tenant); the **MLS epoch chain**
  (`conversation_commits`, where `max(epoch)` is the live group state).
- **Boundaries:** (a) **app role ↔ prune role** — `argus_app` runs each request with `app.tenant_id` set; the
  prune role runs cross-tenant with the GUC **unset** and must, by RLS, only ever see/delete past-window rows.
  (b) **tenant ↔ tenant.** (c) **server ↔ client** — unchanged; crypto-blind, opaque ciphertext only.
  (d) **worker ↔ DB** — local-trust socket, no secret, no egress.

## 3. Threats (STRIDE-lite)

- **[Elevation — load-bearing] PR #262 OR-combine bypass.** `messages_tenant_isolation` and
  `commits_tenant_isolation` are currently **PUBLIC** (no `TO` clause) — unlike `audit_events`/`auth_sessions`,
  re-scoped `TO argus_app` in `0043`. RLS permissive policies **OR-combine**, and the prune role *can*
  `set_config('app.tenant_id', <victim>)`. A PUBLIC isolation policy that still applies to the prune role would
  OR with the window-only prune policy → a **live-row read/delete bypass** of any tenant's in-window ciphertext.
  **Mitigation (mandatory):** re-scope each table's isolation policy `TO argus_app` **in the same migration that
  first grants the prune role a policy** — `messages` in slice 3, `conversation_commits` in slice 5 — never
  ahead of need; each ships a live-DB RLS regression spec. **This re-scope + the window policy is the single
  load-bearing control of the whole feature.**
- **[Tampering — MLS history fork] Deleting the current/max-epoch commit.** `postCommit` derives the next epoch
  as `max(epoch) + 1`; deleting the per-conversation max-epoch row would let a stale/retried commit reuse that
  freed `unique (tenant_id, conversation_id, epoch)` slot and **fork MLS history**. **Mitigation:** the commit
  `for delete` policy must **DB-enforce "never the current epoch"** via a correlated `EXISTS (… epoch > this.epoch)`
  (or a reviewed `security definer`), so deleting the max row is impossible **even if the worker query is wrong**.
- **[Denial of service — stranded device] Deleting an intermediate commit.** A catching-up device drains commits
  in epoch order and `processCommit()`s each; a deleted `epoch < max` row leaves a **gap** that halts
  advancement, and there is no server gap-recovery today (the device spins, it does not re-invite).
  **Mitigation:** reap only the **oldest contiguous prefix** older than the ceiling (never leave a gap), and
  **do not prune commits at all** until the client missing-commit / sync-lost signal exists (slice-5
  prerequisite).
- **[Information disclosure — over-broad grant] A leaked prune credential reading ciphertext.** **Mitigation:**
  per-table **column-scoped SELECT** — `messages (id, created_at)`, `conversation_commits (id, created_at,
  conversation_id, epoch)` — **never `ciphertext`/`commit`**. PostgreSQL requires SELECT on every column the
  DELETE predicate reads; v1's TTL predicate is fully covered. DELETE stays table-level, RLS-gated to
  past-window rows.
- **[Spoofing — tenant context from unverified input]** `argus_app` sets `app.tenant_id` only from the verified
  `auth.tenantId`, never client input. The prune role's risk is the inverse (it can set the GUC itself) — closed
  by the §3 re-scope.
- **[Denial of service — runaway delete]** Bounded batches with a max-rounds cap; fail-closed non-zero exit on a
  DB-unreachable so `OnFailure=` alerts; a plain `created_at` btree index (tenant-leading indexes can't serve a
  cross-tenant age scan).

## 4. Invariant check (all six)

- **#1 crypto-blind server** — upheld. Metadata-only reads; the column-scoped grant makes reading
  `ciphertext`/`commit` impossible even with a leaked credential. Deletion is not decryption.
- **#2 no secret/content logging** — upheld. **Counts only, no row ids** (these rows are ciphertext-bearing —
  follow `prune-audit.sh` discipline, not the id-logging attachment worker). No DB password anywhere
  (local-trust socket).
- **#3 tenant_id + RLS on every tenant table** — upheld **and reinforced**: both pruned tables already have
  `tenant_id` + FORCE RLS; this track adds the **`TO argus_app` re-scope** (the #262 fix) + window-only prune
  policies. **This is the load-bearing control.**
- **#4 no hand-rolled crypto** — N/A / upheld. No crypto in this path; opaque blobs are deleted untouched.
- **#5 secrets via Key Vault / Managed Identity** — upheld trivially: the worker needs **no secret**
  (in-container local-trust socket); `LOGIN PASSWORD NULL`, like `argus_prune`/`argus_cleanup`.
- **#6 no admin path to content** — upheld. The worker is a metadata-only deletion authority; it exposes nothing
  and cannot read content.

## 5. Decision & mitigations

- **Ship TTL-only v1.** Delete-on-confirmed-delivery is **DEFERRED**: `conversation_receipts` is keyed per
  **user** (`unique (tenant_id, conversation_id, user_id)`, single `delivered_through_*` watermark advanced by
  whichever device acks first) and `GET /sync` is user-scoped — so a delivery gate could delete the only
  server-side ciphertext an offline-but-within-TTL **second device** can still fetch (silent message loss). A
  grace window can't fix a days-offline device. Delivery-confirmed pruning waits on **per-device** delivery
  tracking (out of scope).
- **Prerequisite met:** the prune-safe `(created_at, id)` cursor (slice 1, [#289](https://github.com/Dezoxy/secmes/pull/289)) —
  a returning in-window device pages past a pruned anchor instead of getting an empty page. (Within-window
  no-loss rests on the client **reconnect protocol**, not the cursor alone — `realtime-delivery.md` §6.)
- **Mitigations:** per-table column-scoped SELECT (never ciphertext); the single shared ceiling constant;
  counts-only logging; the contiguity rule + DB-enforced never-current-epoch for commits (slice 5).
- **Gates per slice:** slice 3 (messages boundary migration, no deletion) — `/db-migration`,
  `security-boundary-auditor`, a live-DB RLS regression spec; slice 4 (TTL worker, the only deletion that
  ships) — `infra-reviewer`, shellcheck/Semgrep, a dry-run against a disposable DB; slice 5 (commits, gated) —
  `/db-migration`, `security-boundary-auditor`, live-DB specs incl. never-max-epoch + no-gap. **Slices 3 and 4
  must not be collapsed** — the boundary must merge before any worker can delete.

## 6. Residual risk

- **Device offline > TTL loses never-received history** — accepted; the disappearing-history trade
  `message-history.md` already anticipates. Document in product copy / DPA; do not engineer around it.
- **Reaped rows persist in pre-reap backups** — accepted; identical to audit-prune today.
- **GDPR posture** — Art. 5(1)(e) storage-limitation is the **win** (argus has no message-content retention
  today, the larger ciphertext-bearing sibling of the F1/AR-1 unbounded-`audit_events` must-fix). Art. 17
  erasure is **complementary, non-overlapping**: erasure nulls `sender_user_id` as `argus_app` (column-scoped
  UPDATE); retention deletes **whole rows** as the window-scoped prune role — neither grant widens the other.
- **Metadata residual unchanged** — `metadata-exposure.md`'s row-count/volume leak is *reduced* by bounding
  growth, not eliminated.
- **Sync-lost recovery is passive in v1 (slice 5c)** — a device stranded past commit retention self-heals
  (drops its broken state and re-joins cleanly) **only when** a current member re-adds it; v1 does **not**
  actively trigger that add (no cross-device "stranded" signal and no MLS remove+add/PCS path yet — deferred to
  5c-2). A conversation where no current member re-adds the device stays in the surfaced "needs reconnecting"
  state. This is the same accepted "offline > TTL / both sides offline" trade as the first bullet, extended to
  the own-multi-device case. Aggressive commit pruning (5d/5e) would raise the rate of this state — a further
  reason it stays deferred until 5c-2 lands.

## 7. Binding conditions for the code slices (from the sign-off)

The design is sound; these conditions are **binding on the slices that introduce the code** and must be pinned
by their specs (none blocks this note):

1. **(slice 3, High)** The `messages_tenant_isolation` policy (`0007`) uses the `current_setting('app.tenant_id')::uuid`
   form that **throws when the GUC is unset** — the prune role's normal state. The re-scope must use the `0043`
   `TO argus_app` form (which removes that throwing policy from the prune role), and the RLS spec must assert
   **both** that the GUC-set cross-tenant bypass is **denied** *and* that the prune role's normal **no-GUC
   sweep succeeds** — otherwise the worker silently errors in prod.
2. **(slice 4, Medium)** Use a **dedicated** prune role (e.g. `argus_msg_prune`), not the shared `argus_prune`,
   to keep grants minimal and the #262 surface auditable per table. Slice 4 must add `ALTER ROLE … LOGIN
   PASSWORD NULL` in `deploy.sh` **and** a connectivity probe (mirror the existing prune wiring) so a role that
   can't connect fails the deploy rather than silently never running.
3. **(slice 5, High)** The commit-delete RLS `USING` must embed the correlated `EXISTS (epoch > this.epoch)`
   (or a `security definer`) so max-epoch deletion is DB-impossible — **not** a worker-only check — backed by
   the `(tenant_id, conversation_id, epoch)` index; the worker must **independently** enforce
   contiguous-prefix-only. Pin both `never-max-epoch` and `no-gap-left` in the spec.
4. **(slice 5)** No `DELETE` grant on `conversation_commits` may exist before slice 5.
5. **(all slices)** Logs counts-only, never row ids; commit pruning stays gated on the client
   missing-commit / sync-lost signal.

## 8. Sync-lost recovery (the cond-5 prerequisite) — design update 2026-06-21

A follow-up `security-architect` pass (after slice 4 shipped) confirmed the cond-5 signal does **not** exist
**and** surfaced that a device behind the **oldest *retained* commit epoch** spins forever **today** —
`drainCommits` stops at the first unprocessable commit and the catch-up loop silently retries (a latent bug,
independent of pruning). The prerequisite is therefore being built as its own slices **before** any commit
pruning:

- **Recovery mechanism = re-add by an existing member via a fresh Welcome** — reuse the already-reviewed
  `enrollDevice` → `joinConversationFromPool` path, which **re-runs the out-of-band safety-number
  verification**. We deliberately do **not** add MLS external-commit ("rejoin myself"): it would be new crypto
  surface (invariant #4), need published GroupInfo (new server metadata), and let a device re-insert itself
  without a member's identity check (weaker device trust). Re-add keeps the deletion authority with the group.
- **5a (server, this prerequisite's first slice):** `listCommits` exposes the **oldest retained commit
  epoch** — `min(epoch)` over the whole conversation, in the same RLS-scoped, member-gated transaction — as
  the **`X-Oldest-Retained-Epoch`** response header. **Metadata only**: an integer the server already returns
  per-commit; it never reads or returns the `commit` blob, so invariant #1 holds and the disclosure delta is
  strictly less than what `FetchedCommit.epoch` already carries. A header (not a body field) keeps stale PWAs
  validating the body as `CommitPageSchema` working.
- **5b (client detection — implemented 2026-06-21):** the commit drain now reports whether it advanced plus
  the oldest retained epoch, and a pure, unit-tested `classifyCommitDrain` resolves a non-advancing drain to
  **`sync-lost`** exactly when `oldestRetainedEpoch > localEpoch` (the commit needed to advance is gone),
  otherwise `transient` (retry within a bounded budget). This closes the spin-forever latent bug: a genuine
  gap now escalates to an `onSyncLost` callback and stops, instead of looping. **No content/keys involved** —
  `oldestRetainedEpoch` is metadata that never gates decryption or ordering. Client-only; no server/contract
  change. (Recovery action + UI are 5c.)
- **5c (recovery — implemented 2026-06-21):** a further `security-architect` pass found the originally-planned
  *active* re-add ("a live sibling re-adds the stranded device on its sync-lost") **unimplementable** in v1
  without new server state or the unbuilt MLS remove+add (PCS) path: `onSyncLost` fires only on the *stranded*
  device, no cross-device "stranded" signal exists (adding one is the published-GroupInfo surface ruled out
  above), `conversation_members` is per-*user* so a live sibling can't see a stale leaf from the server, and
  `enrollDevice` skips re-adding an already-present member. So **5c v1 is detect → surface → self-heal**: on
  `sync-lost`, the stranded device clears its **broken group state only** (`deleteConversationState` leaves the
  decrypted **message log** and the **verified-peer** trust records — separate stores — intact) and re-drives
  the existing Welcome drain, then re-joins **fresh** at the current epoch through the unchanged member/Welcome
  path (full out-of-band safety-number re-check, fresh one-time KeyPackage, no key reuse) the moment a current
  member re-adds it. The UI surfaces a "Conversation out of sync — older messages may be unavailable" banner and
  suppresses the composer until re-join. **No new server/crypto surface.** A removed device gains nothing —
  re-add is a member-authorized add commit the server gates with `requireMembership`, so dropping local state
  grants it no path back in.
- **5c-2 (deferred) — active cross-device re-add:** proactively pushing a fresh Welcome to a stranded sibling
  needs either new server state (the cross-device "stranded" signal / published GroupInfo) or the MLS
  remove+add (PCS) path; un-defer with group-chat GA (same trigger as the commit-prune slices).

**Deferred:** the actual commit pruning (the cond-3/4 boundary migration + worker) waits behind 5a–5c **and**
group-chat GA — 1:1 conversations write zero commit rows, so pruning is premature at current scale. Cond-5 is
**met for the detection gate** (5a–5c deliver the sync-lost signal + the spin-forever fix); note that the
recovery it gates is **self-heal-passive** in v1, so aggressive commit pruning would park more conversations in
the "needs reconnecting" state until 5c-2's active re-add lands — another reason 5d/5e stay deferred.

**Sign-off:** `security-architect` — **PASS_WITH_CONDITIONS** (conditions 1–3 above). `crypto-reviewer` —
**PASS_WITH_CONDITIONS** (crypto-blind metadata-only prune path, DB-enforced never-current-epoch, welcomes
excluded, disappearing-history is the only crypto-relevant residual and is accepted; no new crypto). Both
verified every load-bearing claim against the code.
