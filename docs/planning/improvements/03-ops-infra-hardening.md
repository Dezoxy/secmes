# Track 3 — Operational / infra hardening

> **Status:** **TRACK COMPLETE.** Items **A, B, C IMPLEMENTED as runbooks** 2026-06-21 ([#287](https://github.com/Dezoxy/secmes/pull/287),
> PR 3a — docs only); item **D** (realtime delivery-gap detection) **IMPLEMENTED** 2026-06-21 ([#288](https://github.com/Dezoxy/secmes/pull/288), PR 3b). **Correction:** the **first**
> environment being deployed is AWS** (`infra/aws/`, `cd-aws.yml`, the `aws-experiment` environment — see the
> AWS first-deploy runbook), so the runbooks are **AWS-primary** and items B & C were found **already active
> there**. The single-Azure-VM path (`cd.yml`, still described as production in `README.md` /
> `docs/architecture/deploy.md`) is **not yet armed** and currently has **neither** control — so configuring
> its remote state + required reviewers is a **hard prerequisite before that path is armed for production**,
> not an optional follow-up. None of this blocks shipping; it removes single-point risks before GA.

## Summary of the four items

| Item                           | State today                                                                          | Status                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| A. Migration rollback          | Forward-only SQL migrations (44 files, head 0043), no down-path                      | ✅ **Runbook shipped** (PR 3a)                  |
| B. Terraform remote state      | **AWS**: S3 backend already the default/enabled; **Azure** twin still commented/local | ✅ **Documented** (AWS active; Azure required before arming) |
| C. CD per-release approval     | **AWS** `aws-experiment` env has required reviewers; **Azure** `prod` not yet set    | ✅ **Documented** (AWS active; Azure required before arming) |
| D. Realtime delivery guarantee | Redis pub/sub fan-out, frames have no sequence/ACK                                   | ✅ **Implemented** ([#288](https://github.com/Dezoxy/secmes/pull/288), PR 3b) — ephemeral per-socket gap counter |

## A. Migration rollback procedure (net-new)

> ✅ **Implemented (PR 3a):** [`docs/operations/runbooks/migration-rollback.md`](../../operations/runbooks/migration-rollback.md)
> — three recovery paths (failed migration / roll the app image back / restore), each with its data-loss
> trade-off; recovery references the restore runbook in `infra/backup/README.md` (no duplication). The
> pre-migration checkpoint ships as a documented **operator step** (`systemctl start argus-db-backup.service`,
> the existing signed+encrypted worker), **not** auto-wired into `deploy.sh`: the deploy deliberately doesn't
> couple rollout to a B2 round-trip and `argus_backup` only exists after migrate, so auto-wiring is a deferred
> follow-up (recorded in the runbook).

**Problem.** `apps/api/src/db/migrate.ts` applies forward-only migrations (44 files, head `0043`); there is no down-migration
or documented recovery. If a schema change breaks production, the operator has no rehearsed path back.

**Approach.** This is primarily a _runbook_, not a framework. Add `docs/operations/runbooks/migration-rollback.md`
documenting the supported recovery: restore from the nightly B2 DB backup to a point before the bad
migration, then re-apply known-good migrations. Pair it with a pre-migration backup checkpoint step in the
deploy flow so a fresh restore point always exists. (A full reversible-migration framework is explicitly
_not_ proposed — migrations run ~once per slice and the backup-restore path is simpler and already exists.)

**Verify.** Dry-run the runbook against a disposable DB: apply N migrations, take a backup, apply a bad
N+1, then follow the runbook to land back at N. Document the exact commands and timing.

## B. Activate Terraform remote state (activate existing design)

> ✅ **Documented (PR 3a) + correction.** On the **AWS path** (deployed first), remote state is **already the
> default/enabled** — `infra/aws/terraform/versions.tf` has `backend "s3" {}` (encrypted + DynamoDB-locked +
> versioned), bootstrapped via `make -C infra/aws bootstrap`; there is **nothing to activate**. The text
> below describes the **Azure** twin: the single-Azure-VM path (still described as production in
> `docs/architecture/deploy.md`) runs on **local state** and is **not yet armed** — so activating its
> `azurerm` backend is a **hard prerequisite before that path is armed for production**, not an optional
> follow-up. See the "Release safety controls" section in
> [`docs/operations/runbooks/aws-first-deploy.md`](../../operations/runbooks/aws-first-deploy.md).

**Problem.** `infra/azure/terraform/versions.tf` runs on **local state** today and the file itself warns:
state holds sensitive ids and must move to an encrypted, locking remote backend before CI/sharing. With
local state, a lost/stale state file plus an existing VM can make `terraform apply` try to **re-create the
running host**.

**Approach.** Uncomment and wire the already-written `backend "azurerm"` block (tfstate resource group +
storage account + container), create that storage out-of-band, and `terraform init -migrate-state`. This
is a gated infra action (`terraform apply` / state migration require explicit human confirmation per
AGENTS.md) — the doc captures the exact steps; execution happens during Azure arming.

**Verify.** After migration, `terraform state list` reads from the azurerm backend; a second clone with no
local `.terraform/` can `init` and `plan` with **no diff**.

## C. CD per-release approval gate (one-time GitHub setting)

> ✅ **Documented (PR 3a).** On the **AWS path** (deployed first) the `aws-experiment` GitHub Environment
> already has required reviewers, and the IAM deploy role's OIDC trust is bound to
> `repo:OWNER/REPO:environment:aws-experiment` (`infra/aws/terraform/iam.tf:102`), so each `aws-v*` tag pauses
> for approval before the root SSM command runs — and only a job running in that approval-gated environment can
> assume the role (the binding is to the environment + its approval, not a branch/ref). The **Azure** `prod`
> environment (`cd.yml`) has **no** required reviewers yet — configuring them is a **hard prerequisite before
> the Azure path is armed for production**. Captured with verify steps in the "Release safety controls"
> section of [`docs/operations/runbooks/aws-first-deploy.md`](../../operations/runbooks/aws-first-deploy.md).

**Problem.** `.github/workflows/cd.yml` already has a two-layer gate: the `vars.ENABLE_DEPLOY` master
kill-switch _and_ `environment: prod` (lines ~117–130, with comments instructing that `prod` be given
required reviewers). The Environment is referenced but its **protection rules are not yet configured**, so
deploy currently leans on a flippable repo variable alone.

**Approach.** No code change. In GitHub repo settings, configure the `prod` Environment with **required
reviewers** (per-release manual approval) and confirm the OIDC federated subject is bound to
`repo:OWNER/REPO:environment:prod` (`var.github_deploy_subject` in the Azure Terraform). Record this as a
checklist item in the deploy runbook so arming can't skip it.

**Verify.** A dry tagged release pauses at the `deploy` job awaiting approval; an unapproved run cannot
execute `az vm run-command`.

## D. Realtime delivery-gap detection (net-new)

> ✅ **Implemented (PR 3b).** Preceded by a `security-architect` + `crypto-reviewer` design pass (both agreed on
> the posture; crypto-reviewer PASS_WITH_CONDITIONS, all met). **The written proposal below was corrected on two
> load-bearing points** (same staleness pattern as Tracks 1/2):
>
> 1. **Ephemeral per-socket, not persisted at message-write.** The counter (`deliverySeq` + `deliveryPrevSeq`)
>    is stamped at **fan-out** as in-memory per-`(socket, conversation)` state on the gateway connection — the
>    lossy hop is the live socket, not the DB. This needs **zero schema change / no RLS surface / no new
>    at-rest metadata**, and dissolves the race-safety, gaplessness, and pruned-hole edge cases a persisted
>    write-time column would create. Added to `@argus/contracts` (`MessageEventSchema`) as **optional** siblings
>    of `conversationId`, **outside** the MLS envelope; named `delivery*` and documented as carrying no
>    cryptographic guarantee (distinct from the MLS `epoch` / ratchet generation).
> 2. **No server-consumed ACK in v1.** The goal — client detects a gap and self-heals — needs only the
>    **outbound** counter; the client re-fetches over the existing `(created_at, id)` catch-up (dedup by id).
>    Dropping the inbound ACK makes it **structurally impossible** to wire delivery into deletion — the exact
>    Track 4 per-user-vs-per-device boundary. A persisted commit-order watermark (the enterprise variant that
>    makes `/sync` self-sufficient) stays a deferred, separate design. **Tail-withholding remains an accepted
>    relay residual** (documented in `realtime-delivery.md` §6).
>
> Files: `packages/contracts/src/index.ts`, `apps/api/src/realtime/realtime.gateway.ts`,
> `apps/web/src/lib/ws.ts`, `apps/web/src/features/chat/useLiveConversations.ts` (+ gateway/ws/classifier
> specs), and threat-model notes in `docs/threat-models/realtime-delivery.md` / `metadata-exposure.md`.

**Problem.** `apps/api/src/realtime/realtime.gateway.ts` fans out over Redis pub/sub
(`redis-realtime-bus.ts`), which is fire-and-forget: a frame dropped on a flaky socket or delivered out of
order is undetectable by the client. Message _content_ integrity is guaranteed by MLS, but _delivery_
completeness is not observable.

**Approach.** Add a per-conversation monotonic sequence number to outbound realtime frames and a
lightweight client ACK, so the client can detect a gap and fall back to the existing `syncMessages` REST
path to backfill. This rides on metadata only — **no plaintext, no keys** cross the server (AGENTS.md
invariant #1 holds). Sequence/ACK shapes go through `@argus/contracts` (Zod) like every other frame.

**Files touched (both sides).** This track is _not_ server-only: the gateway/bus emit the sequence number
(`apps/api/src/realtime/realtime.gateway.ts`, `redis-realtime-bus.ts`) **and** the web client
(`apps/web`) must track the per-conversation sequence, detect a gap, and trigger the `syncMessages`
backfill — without the client side, a gap is observable but silently discarded. The follow-up PR is
expected to span `apps/api` + `apps/web` + `@argus/contracts`.

**Verify.** A gateway test that drops a frame asserts the client observes a sequence gap and triggers a
sync backfill; `realtime.gateway.spec.ts` / `.e2e.spec.ts` extended accordingly.

## Risks & what could break

- **B and C are gated infra/settings actions** — they require explicit human confirmation and happen
  during Azure arming, not in this docs PR.
- **D touches the hot realtime path** — addressed in PR 3b by making the counter **ephemeral per-socket** (no
  shared/persisted sequence to coordinate, so race-safety is by construction on the single-threaded event
  loop), leaving at-rest message ordering/storage untouched, and adding the fields as **optional** so an old
  client ignoring them still works.
- **A must not imply automatic destructive rollback** — the runbook is restore-based and human-driven.

## Out of scope

Implementing B and C beyond documentation (they are arming-time actions), and any change to MLS/crypto.
