# Planning

All plan, roadmap, and step-tracking docs for argus. The **canonical phasing** lives in
[`roadmap/`](roadmap/) (split per phase, with a progress table and a remaining-work rollup); everything
else here is a focused plan for one effort, each carrying a `**Status:**` header.

Status vocabulary used across these docs: **PROPOSED** → **APPROVED** → (in progress) → **COMPLETE**,
plus **DRAFT** / **REVISED** / **ARCHIVE**. Dates are ISO (`YYYY-MM-DD`).

## The build roadmap

- [`roadmap/`](roadmap/) — the living checkpoint checklist, split by phase. Start at
  [`roadmap/README.md`](roadmap/README.md) for the progress table and what's left.
- [`roadmap/history.md`](roadmap/history.md) — the archived per-checkpoint build log (PR-by-PR, snapshot
  2026-06-14). New status goes in the phase files, not here.

## Focused plans

| Plan                                                                       | Scope                                            | Status                          |
| -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| [frontend-plan.md](frontend-plan.md)                                       | 14-step `apps/web` rebuild + F1–F6 (roadmap #44a)| COMPLETE (PRs #87–#146)         |
| [frontend-rebranding-roadmap.md](frontend-rebranding-roadmap.md)           | "Minimal Messenger OS" UI/UX rebrand             | in progress (v2 sketches live)  |
| [private-messenger-redesign-plan.md](private-messenger-redesign-plan.md)   | Product pivot: enterprise OIDC → passkey messenger | PLAN ONLY                     |
| [contact-list-recovery-plan.md](contact-list-recovery-plan.md)             | Server-backed Friends list + tap-to-resume       | PARTIAL (PRs #234–#238)         |
| [controller-spec-coverage-plan.md](controller-spec-coverage-plan.md)       | Close the controller-spec gap (3 slices)         | APPROVED (not started)          |
| [security-review-campaign-plan.md](security-review-campaign-plan.md)       | 6-slice adversarial review → evidence notes      | done (see `../reviews/`)        |

## Codebase improvement tracks

- [`improvements/`](improvements/) — health-review follow-ups (messaging-service refactor, RLS test
  coverage, ops hardening, message retention). See [`improvements/README.md`](improvements/README.md) for
  priority order and constraints.
