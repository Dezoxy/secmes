# Codebase improvement tracks

> **Status:** PROPOSED 2026-06-21 — planning docs only. No application code changes in this PR.
> **Origin:** A full codebase-health review (size / quality / difficulty) of the monorepo. The review
> found a top-tier, security-hardened codebase whose only real debt is concentrated in three places.
> These docs scope the fixes; each becomes its own follow-up PR once reviewed.

## What the review found (one paragraph)

~48.7k lines of production code across `apps/api`, `apps/web`, `packages/crypto`, `packages/contracts`,
and `infra`. Quality is excellent and mechanically enforced (strict TypeScript, 1 `as any` in the whole
tree, 0 `@ts-ignore`, Zod on all routes, 13 RLS-enforced tables, 13 CI gates incl. Semgrep with 9 custom
rules). Difficulty is medium-high but mostly _inherent_ to building E2EE (MLS / RFC 9420). The only
actionable debt: a handful of oversized files, thin unit-isolation on a few API services plus
non-exhaustive RLS test coverage, and several operational single-point risks.

## The tracks

| #   | Track                                                                        | Type            | Risk if untouched                                  | Net-new surface |
| --- | ---------------------------------------------------------------------------- | --------------- | -------------------------------------------------- | --------------- |
| 1   | ✅ [Messaging service refactor](./01-messaging-service-refactor.md)          | Readability     | Merge-conflict & onboarding cost on a 1,185-LOC file | none            |
| 2   | ✅ [Test coverage + RLS assertions](./02-test-coverage-and-rls-assertions.md) | Test hardening  | A typo'd RLS policy could ship a cross-tenant leak | tests only      |
| 3   | ✅ [Ops / infra hardening](./03-ops-infra-hardening.md)                       | Operational     | No rollback story; flippable deploy gate; lossy WS | small           |
| 4   | 🟡 [Message retention & ciphertext pruning](./04-message-retention-and-pruning.md) | Retention / privacy | `messages` ciphertext grows forever — cost, breach/subpoena surface, no GDPR storage-limitation story | small (cursor contract + role + worker) |

> Track 4 was added 2026-06-21 — a retention/data-minimization improvement, not part of the original
> three-track codebase-health review. The server retains every relayed MLS ciphertext forever; this track
> makes it behave like the transient relay it is.

**Priority order:** 4 → 2 → 1 → 3. Track 4 leads because the deletion **boundary** should be designed and in
place *before* production accumulates ciphertext that can never be reclaimed (and it delivers the GDPR
storage-limitation story). Track 2 is the highest-*severity* item (a typo'd RLS policy is a silent
cross-tenant leak) and should follow immediately; Track 1 is the biggest readability win at zero behavior
change; Track 3 is mostly activating things already designed.

**Progress:**

- ✅ **Track 1 implemented** (2026-06-21, [#285](https://github.com/Dezoxy/secmes/pull/285)) —
  `messaging.service.ts` split into four collaborators behind an unchanged façade; the 45-test contract spec
  passes unchanged.
- ✅ **Track 2 implemented** (2026-06-21, [#286](https://github.com/Dezoxy/secmes/pull/286)) — three live-DB service specs (`admin`, `user`, `devices`) plus a
  catalog-driven `db/rls-coverage.spec.ts` that fails CI if any non-allowlisted `public` table lacks forced
  `app.tenant_id` RLS. (It already surfaced the drift: 19 tenant-scoped tables today, not the "13" the docs
  repeated.) Tests only.
- 🟡 **Track 3 items A/B/C implemented** (2026-06-21, [#287](https://github.com/Dezoxy/secmes/pull/287), PR 3a) — a migration-rollback runbook
  (`docs/operations/runbooks/migration-rollback.md`) plus a "Release safety controls" section in
  `aws-first-deploy.md` documenting locked Terraform remote state + the per-release approval gate.
  **Correction:** the **first environment deployed is AWS** (its release-safety controls are already active);
  the single-Azure-VM path (still production-of-record in `deploy.md`) is **not yet armed** and these controls
  are a **hard prerequisite before arming it**. Docs only.
- ✅ **Track 3 item D implemented** (2026-06-21, [#288](https://github.com/Dezoxy/secmes/pull/288), PR 3b) — realtime **delivery-gap detection**: an **ephemeral
  per-socket** `deliverySeq`/`deliveryPrevSeq` the gateway stamps at fan-out so the client notices a
  dropped/reordered live frame and self-heals over the existing `(created_at, id)` backfill. Corrected the
  written proposal on two points after the security-architect + crypto-reviewer pass: ephemeral (no DB
  column/RLS surface) instead of persisted-at-write, and **no server-consumed ACK** (keeps the Track 4
  delete-on-delivery boundary intact). Metadata-only, outside the MLS envelope. **Track 3 is now complete.**

- 🟡 **Track 4 slice 1 implemented** (2026-06-21, [#289](https://github.com/Dezoxy/secmes/pull/289)) — the **prune-safe catch-up cursor**, the
  safety prerequisite that must land before any deletion. `listMessages` now stamps each message with an
  opaque, position-carrying `(created_at, id)` `cursor` (reusing the proven `/sync` encoding) that the client
  echoes as `after`; the legacy bare-message-id cursor stays valid, so cached PWA bundles keep paging. A
  cursor now survives its anchor message being reaped. **No deletion yet** — slices 2-5 (threat model →
  `messages` boundary migration → TTL worker → commits) follow as their own PRs.

- 🟡 **Track 4 slice 2 implemented** (2026-06-21, [#290](https://github.com/Dezoxy/secmes/pull/290)) — the
  **threat-model note** (`docs/threat-models/message-retention.md`), written before the code slices. Carries a
  `security-architect` + `crypto-reviewer` sign-off (both **PASS_WITH_CONDITIONS** — the design is validated
  against the code; the conditions are binding on slices 3–5 and recorded in the note's §7). No code.

- 🟡 **Track 4 slice 3 implemented** (2026-06-21, [#291](https://github.com/Dezoxy/secmes/pull/291)) — the
  **`messages` prune boundary** (`0044_messages_prune_role.sql`), the deletion *authority* built and proven
  before any worker. A dedicated `argus_msg_prune` role (`nologin nobypassrls`), the
  `messages_tenant_isolation` re-scope `TO argus_app` (the #262 fix), window-scoped prune `select`/`delete`
  policies (90-day ceiling), a column-scoped `(id, created_at)` SELECT (never `ciphertext`), and a
  `created_at` index — mirroring `0043`. The live-DB RLS spec proves §7 cond 1 both ways (no-GUC sweep
  succeeds AND the GUC-set bypass is denied). **No deletion** — the role stays `NOLOGIN`; the worker is slice 4.

- 🟡 **Track 4 slice 4 implemented** (2026-06-21, [#292](https://github.com/Dezoxy/secmes/pull/292)) — the **TTL prune worker**, the v1 deletion
  (and the only deletion this track ships). `infra/retention/prune-messages.sh` + a daily systemd
  `service`/`timer`, a single-table clone of `infra/audit-prune/`: connects in-container as `argus_msg_prune`
  (no password), batch-deletes `messages` past the 90-day ceiling (same literal as the `0044` RLS policy — the
  DB-enforced hard floor), logs **counts only**, and **fails closed**. `deploy.sh` adds the role's
  `LOGIN PASSWORD NULL` + a connectivity probe (§7 cond 2). No app code, migration, or contract change.

- 🟡 **Track 4 slice 5 re-sliced; slice 5a implemented** (2026-06-21, [#293](https://github.com/Dezoxy/secmes/pull/293)) — a `security-architect`
  pass found the original slice 5 (`conversation_commits` pruning) blocked on a recovery signal that doesn't
  exist, **and** that a device behind the oldest *retained* commit epoch spins forever **today** (a latent
  bug). So the tail splits into a prerequisite — **5a** server exposes the oldest retained commit epoch
  (read-only `X-Oldest-Retained-Epoch` header, metadata-only `min(epoch)`, no deletion/migration), **5b**
  client detects "sync-lost", **5c** recovery (re-add via the existing member/Welcome path) + UI — and the
  **deferred** pruning **5d** (commit-prune boundary migration) + **5e** (contiguity-preserving worker). 5d–5e
  are deferred because 1:1 chats write zero commits (only group chat does, slowly) — un-defer at group-chat GA.

- 🟡 **Track 4 slice 5b implemented** (2026-06-21, [#296](https://github.com/Dezoxy/secmes/pull/296)) — **client sync-lost detection** (no UI, no
  recovery action yet). The web client reads the 5a `X-Oldest-Retained-Epoch` header, the commit drain now
  reports whether it advanced + the oldest retained epoch, and a pure, unit-tested `classifyCommitDrain` tells
  a transient stall (retry within a bounded budget) from a genuine **`sync-lost`** gap (the commit needed to
  advance was pruned). The catch-up loop + `onCommit` escalate a real gap to an `onSyncLost` callback (wired in
  5c) — closing the spin-forever latent bug. Client-only; no server, contract, migration, or wire change.

- 🟡 **Track 4 slice 5c implemented** (2026-06-21, PR _pending_) — **sync-lost recovery + UI affordance**. A
  `security-architect` pass found the originally-planned *active* re-add unimplementable in v1 (no cross-device
  "stranded" signal without new server state; replacing a stale leaf needs the unbuilt MLS remove+add/PCS path),
  so 5c is **detect → surface → self-heal**: on `sync-lost` the stranded device drops its **broken group state
  only** (a new `recover-sync-lost.ts` driver — the decrypted message log + verified-peer trust are separate
  stores, preserved) and re-drives the existing Welcome drain, then re-joins **fresh** at the current epoch
  through the unchanged member/Welcome path (full out-of-band safety-number re-check) the moment a current
  member re-adds it. `ChatScreen` shows a "Conversation out of sync — older messages may be unavailable" banner
  and suppresses the composer until re-join. **Active cross-device re-add is deferred to 5c-2** (group-chat GA,
  same trigger as 5d/5e). Client-only; no server, contract, migration, or wire change.

Track 4's v1 message TTL deletion ships (slice 4); the commit-pruning tail is re-sliced — its prerequisite is
landing now (5a–5c done; active re-add 5c-2 + the actual pruning 5d–5e deferred until group chat is GA). Track 4 stays 🟡.

## Constraints every track must respect

All work stays inside the [AGENTS.md](../../../AGENTS.md) non-negotiable invariants — most relevant here:

- The server stays **crypto-blind**; refactors must not move any plaintext/key handling onto the server.
- Every tenant-scoped table keeps `tenant_id` + an enforced RLS policy (Track 2 _verifies_ this, never relaxes it).
- No secrets in code/logs; infra secrets stay delivered as files via Managed Identity (Track 3).
- Each track ships as its own PR through the two-reviewer flow (Codex + `@claude`) with a product-owner
  "How to verify by hand" section.
