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
| 1   | [Messaging service refactor](./01-messaging-service-refactor.md)             | Readability     | Merge-conflict & onboarding cost on a 1,185-LOC file | none            |
| 2   | [Test coverage + RLS assertions](./02-test-coverage-and-rls-assertions.md)   | Test hardening  | A typo'd RLS policy could ship a cross-tenant leak | tests only      |
| 3   | [Ops / infra hardening](./03-ops-infra-hardening.md)                          | Operational     | No rollback story; flippable deploy gate; lossy WS | small           |
| 4   | [Message retention & ciphertext pruning](./04-message-retention-and-pruning.md) | Retention / privacy | `messages` ciphertext grows forever — cost, breach/subpoena surface, no GDPR storage-limitation story | small (1 role + 1 worker) |

> Track 4 was added 2026-06-21 — a retention/data-minimization improvement, not part of the original
> three-track codebase-health review. The server retains every relayed MLS ciphertext forever; this track
> makes it behave like the transient relay it is.

**Priority order:** 4 → 2 → 1 → 3. Track 4 leads because the deletion **boundary** should be designed and in
place *before* production accumulates ciphertext that can never be reclaimed (and it delivers the GDPR
storage-limitation story). Track 2 is the highest-*severity* item (a typo'd RLS policy is a silent
cross-tenant leak) and should follow immediately; Track 1 is the biggest readability win at zero behavior
change; Track 3 is mostly activating things already designed.

## Constraints every track must respect

All work stays inside the [AGENTS.md](../../AGENTS.md) non-negotiable invariants — most relevant here:

- The server stays **crypto-blind**; refactors must not move any plaintext/key handling onto the server.
- Every tenant-scoped table keeps `tenant_id` + an enforced RLS policy (Track 2 _verifies_ this, never relaxes it).
- No secrets in code/logs; infra secrets stay delivered as files via Managed Identity (Track 3).
- Each track ships as its own PR through the two-reviewer flow (Codex + `@claude`) with a product-owner
  "How to verify by hand" section.
