# Implementation plan: close the controller-layer spec gap (full coverage + standing policy)

> **Status:** APPROVED 2026-06-19 — owner confirmed **three PRs** (Slices A/B/C) and the **CI sibling-spec
> guard is in** (Slice C). Slice A detail gets locked in plan mode before any spec is written.
> **Origin:** Two independent reviews flagged the same hole — Fable's multi-hat repo review
> (`docs/archive/fable5-thoughts.md`, "6 of 10 controllers have no spec") and the contact-list-recovery
> multi-aspect review (the deferred uniform-202 controller spec). Today it is **16 of 18 controllers with
> no spec**. The denominator was understated and the gap is wider than first reported.
> **Sits behind the first AWS deploy** — this is test + docs hardening, net-new surface is zero, it does
> not block shipping. But it is the one concrete engineering task two reviews agree on that is *not*
> blocked on deploy arming.

## Owner ask

"If we're closing this gap, do it properly — cover **all** the controllers (more professional than
cherry-picking), and adjust the docs (AGENTS.md / CLAUDE.md) so it becomes a standing rule, not a
one-off."

## The problem in one picture

```
         Playwright E2E (12 suites)   ← user flows through the real stack
                  ▲
        ── controller layer ──         ← ONLY 2 specs today: app.controller, me.controller
                  ▼
   10 service specs + live-DB RLS      ← business logic, authz, tenant isolation (well covered)
```

Every controller is exercised *above* (E2E) and *below* (service/RLS), but the **seam itself** — DTO/Zod
validation rejection, exact HTTP status codes (the **uniform-202** enumeration defense), `@Public` vs
guarded wiring, audit-field sanitisation, IDOR/404-no-oracle mapping — is not pinned by a fast unit spec.
A NestJS or Zod bump, or a careless edit, can break it silently between E2E runs. On a security product the
controller layer *is* the HTTP attack surface, so "tested above and below, hollow in the middle" is the
wrong shape.

## Design decision: two spec tiers (this is the crux)

Auth is enforced by a **global** `JwtAuthGuard` (`APP_GUARD`, deny-by-default; routes opt out with
`@Public()`). Pipes (`ZodValidationPipe`, `ParseUUIDPipe`) and `@HttpCode`/`@Throttle` are likewise applied
by the framework. **None of these fire when a spec does `new Controller()` and calls a method directly** —
so the existing pattern alone leaves the most security-relevant wiring untested. We use two complementary
tiers, both fast and DB-free where possible:

1. **Behaviour tier (direct instantiation)** — the established `me.controller.spec.ts` pattern: construct
   the controller with real/light-fake services and assert what the *method body* does — correct service
   call + args, response-shape mapping, the uniform-202 constant body, audit-field sanitisation
   (`ARGUS_ID_RE`), error pass-through. Some are integration (live DB, `describe.skipIf(!DATABASE_URL)`),
   most are pure unit with a faked service.
2. **Contract tier (metadata reflection)** — a tiny shared helper reads decorator metadata *without
   booting Nest* and pins the route's security contract: `@Public()` present/absent (via the
   `IS_PUBLIC_KEY` reflector), `@HttpCode` value (202/204/200), `@UseGuards` (AdminGuard/CfAccessGuard),
   `@Throttle` limits, and which pipe guards each param. This is the tier that catches "someone removed the
   guard" or "someone changed 202→200" — the silent, dangerous regressions.

> A heavier third tier (full `Test.createTestingModule` + supertest for true 401/400 over HTTP) is **out of
> scope** — it's slow, needs the whole module graph, and the contract tier already pins the wiring that
> would produce those codes. Note this explicitly so the omission is a decision, not an oversight.

The shared helper (`apps/api/src/common/__test__/route-meta.ts` or similar) is built once in Slice A and
reused everywhere. Decide its exact shape against the real reflector keys when building it.

## Controller inventory (18) — tiered by boundary weight

**Security-load-bearing (rich specs, both tiers) — 8:**
`friends` (uniform-202, 404-no-oracle, audit sanitisation, per-action throttles) · `messaging` ·
`welcomes` · `auth/webauthn` (multiple `@Public` + `PublicRateLimit`) · `auth/session-token` (`@Public`) ·
`auth/breakglass` (`CfAccessGuard` + `AdminGuard` + `@Public` login) · `gdpr` (no-content-to-admin) ·
`admin` (metadata-only invariant).

**Moderate (contract tier + targeted behaviour) — 6:**
`key-directory` · `devices` · `attachments` · `tenants` · `receipts` · `sync`.

**Thin pass-throughs (contract tier, minimal behaviour) — 4:**
`users` · `push` · `me` (extend existing) · `app` (extend existing).

## Slices (each = one PR through the standard dual-review flow)

### Slice A — harness + policy + highest-risk controllers
Branch: `test/controller-specs-slice-a`. Delivers protection immediately and sets the pattern + the rule.
- [ ] Build the shared **route-meta reflection helper** + a couple of self-tests proving it reads
      `@Public`, `@HttpCode`, `@UseGuards`, `@Throttle`, and param pipes correctly.
- [ ] Specs for the **security-load-bearing 8**: `friends`, `messaging`, `welcomes`,
      `auth/webauthn`, `auth/session-token`, `auth/breakglass`, `gdpr`, `admin`.
      Each asserts: correct guard/`@Public` posture (contract tier) **and** key body behaviour
      (uniform-202 constant for friends; no-content-to-admin for gdpr/admin; status codes; sanitisation).
- [ ] **Policy edit — AGENTS.md only** (see "Docs" below). CLAUDE.md left untouched by design.
- [ ] `security-boundary-auditor` pass (its exact area: the HTTP authz/guard seam).

### Slice B — messaging + identity cluster
Branch: `test/controller-specs-slice-b`.
- [ ] Specs for the **moderate 6**: `key-directory`, `devices`, `attachments`, `tenants`, `receipts`,
      `sync`. Contract tier on every route + targeted behaviour where the method does real mapping.

### Slice C — remaining controllers + CI enforcement guard ✅ shipped
Branch: `test/controller-specs-slice-c`. The guard goes **last** so it flips green exactly when coverage is
complete (adding it earlier would red-fail CI until every spec exists).
- [x] Specs for the **thin 4**: `users`, `push` (new); extend `me` and `app` to the contract tier.
- [x] **Coverage guard**: implemented as a **vitest meta-test**
      (`apps/api/src/common/testing/controller-spec-coverage.spec.ts`) — not a `scripts/` step or Semgrep
      rule — asserting every `*.controller.ts` has a sibling `*.controller.spec.ts` (self-checks that the
      glob found controllers, so it can't pass vacuously). With all 18 covered it passes on landing and the
      gap can never silently reopen.
- [x] No new CI workflow wiring: the guard runs inside the existing `pnpm -r test` step (the CI `build-test`
      job **and** the local pre-push gate), so it gates merges and gives developers a fast local red.

## Docs to adjust

- **AGENTS.md (single source of truth — the rule lives here):**
  - *Definition of done*: add — "New/changed controller → a controller spec asserting the route's auth
    posture (`@Public` vs guarded), DTO/Zod validation wiring, and the status/error contract (incl. any
    uniform-202 / 404-no-oracle behaviour)."
  - *Procedures → New/changed endpoint*: add a bullet pointing at the controller-spec requirement and the
    two-tier pattern.
  - *Review criteria → Server boundary*: add "controller spec pins guard + status contract" to the list.
- **CLAUDE.md: no change.** Repo convention is that *rules* live in AGENTS.md (shared with Codex); CLAUDE.md
  holds only Claude-specific wiring. A controller-spec rule is tool-agnostic, so adding it to CLAUDE.md
  would split the source of truth and drift from Codex. Deliberately omitted.

## Verification (per slice)

1. `pnpm --filter @argus/api typecheck` — new specs compile.
2. `pnpm --filter @argus/api test` — unit/contract-tier specs pass without a DB; integration-tier specs
   auto-skip without `DATABASE_URL` (same as `me.controller.spec.ts`).
3. With a live DB (`make up && pnpm --filter @argus/api db:migrate`), the integration-tier specs run and
   pass.
4. Full gate before each PR: `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check`.
5. Slice C only: confirm the CI sibling-spec guard is green with full coverage, and red if a controller
   spec is deleted (prove the gate works).

## Gates (every slice)

- `security-boundary-auditor` after Slice A (and Slice B if messaging authz shifts) — the guard/authz seam
  is exactly its remit.
- `/code-review` (medium) over the branch diff before each PR.
- Standard dual review (Codex + `@claude`), per AGENTS.md; only pause for `gh pr merge`.

## Out of scope

- Full HTTP-level (supertest) 401/400 tests — covered by the contract tier's wiring assertions; see the
  tiering note above.
- The `MessagingService` god-object split and `ChatScreen` god-component (Fable backend #1 / frontend #1) —
  separate maintainability work, not this gap.
- Any deploy-arming item (S2 audits, 8a staging) — those remain the higher-priority track; this is the
  not-blocked-on-arming task that runs alongside.

## Decisions (owner-confirmed 2026-06-19)

- **Three PRs** (Slices A/B/C) — Slice A delivers the real security value on its own and 18 specs + docs +
  a CI guard in one diff reviews badly.
- **CI sibling-spec guard is in**, landing last (Slice C) so it flips green exactly when coverage completes.
