# Track 3 — Operational / infra hardening

> **Status:** PROPOSED 2026-06-21. Two items are net-new; two are _activating_ designs already in the repo.
> Sits behind the first Azure deploy — none of this blocks shipping, but it removes single-point risks
> before the platform is armed.

## Summary of the four items

| Item                          | State today                                                                 | Work required                          |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| A. Migration rollback         | 44 forward-only SQL migrations, no down-path                               | **Net-new**: documented procedure      |
| B. Terraform remote state     | `azurerm` backend already written (commented) in `versions.tf`, local for now | **Activate** the documented backend    |
| C. CD per-release approval    | `prod` GitHub Environment already wired in `cd.yml`; reviewers not yet set  | **One-time GitHub setting** (no code)   |
| D. Realtime delivery guarantee | Redis pub/sub fan-out, frames have no sequence/ACK                          | **Net-new**: ACK / sequence numbers    |

## A. Migration rollback procedure (net-new)

**Problem.** `apps/api/src/db/migrate.ts` applies 44 forward-only migrations; there is no down-migration
or documented recovery. If a schema change breaks production, the operator has no rehearsed path back.

**Approach.** This is primarily a _runbook_, not a framework. Add `docs/operations/runbooks/migration-rollback.md`
documenting the supported recovery: restore from the nightly B2 DB backup to a point before the bad
migration, then re-apply known-good migrations. Pair it with a pre-migration backup checkpoint step in the
deploy flow so a fresh restore point always exists. (A full reversible-migration framework is explicitly
_not_ proposed — migrations run ~once per slice and the backup-restore path is simpler and already exists.)

**Verify.** Dry-run the runbook against a disposable DB: apply N migrations, take a backup, apply a bad
N+1, then follow the runbook to land back at N. Document the exact commands and timing.

## B. Activate Terraform remote state (activate existing design)

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

## D. Realtime ACK / sequence numbers (net-new)

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
- **D touches the hot realtime path**; sequence assignment must be race-safe under the single-VM Redis bus
  and must not change at-rest message ordering or storage. Keep it additive and backward-compatible so an
  old client ignoring the new fields still works.
- **A must not imply automatic destructive rollback** — the runbook is restore-based and human-driven.

## Out of scope

Implementing B and C beyond documentation (they are arming-time actions), and any change to MLS/crypto.
