# Track 2 — Close API spec gaps + make RLS coverage exhaustive

> **Status:** IMPLEMENTED 2026-06-21. Tests only — no production code change. Highest-priority track.

## Problem

Two gaps in an otherwise strong test suite (119 test files):

1. **Three API services have no dedicated unit spec** — `admin.service.ts`, `users/user.service.ts`,
   `devices/devices.service.ts`. They are exercised indirectly (E2E + controller specs), but their
   branch logic is not pinned in isolation. (Blob storage is _not_ in this list: `s3-blob-store.spec.ts`
   already covers the implementation.)
2. **RLS coverage is real but not exhaustive.** There are focused suites (`rls.spec.ts`,
   `messaging-rls.spec.ts`, `friendships-rls.spec.ts`, `attachments-rls.spec.ts`,
   `audit-prune-rls.spec.ts`), but they assert a _subset_ of the tenant-scoped tables by hand. A new table — or a typo in a `USING` / `WITH CHECK`
   clause on an existing one — can ship without any test catching it. (The hand-list had already drifted: the
   live catalog holds **18** tables isolated via `app.tenant_id` + the `tenants` root keyed on `id` = **19**,
   not the "13" repeated in older docs.)

## Why it matters

A typo'd or missing RLS policy is the single highest-impact latent bug in a multi-tenant E2EE product: it
is a silent cross-tenant data leak that compiles, passes the happy-path tests, and violates AGENTS.md
invariant #3. Coverage that enumerates tables by hand will always lag the schema. We want the test to
fail the moment _any_ tenant-scoped table lacks an enforced policy.

## Proposed approach

### Part A — service specs

Add `admin.service.spec.ts`, `user.service.spec.ts`, `devices.service.spec.ts` following the established
pattern: **live-DB integration specs** (`describe.skipIf(!DATABASE_URL)`, fixtures seeded via `getDb().sql`)
that instantiate the service directly and **fake only the injected Nest deps** (e.g. `AuditService`,
`RealtimeBus`) — mirroring `gdpr.service.spec.ts` and `messaging.service.spec.ts`. (These three services are
almost entirely DB-bound — every meaningful branch runs inside `withTenant` — so a literal "no DB" spec would
exercise mocks, not behaviour; the no-DB style stays reserved for pure-crypto units like
`auth.service.spec.ts`.) Cover authz branches, not-found / no-oracle behaviour, and audit-event recording —
the devices specs mint real Ed25519 enroll/withdraw proofs via `@argus/crypto/device-proof`.

### Part B — generic RLS assertion helper (the durable win)

Add a single live-DB spec (`db/rls-coverage.spec.ts`) that is **data-driven off the catalog**, not a
hand-list. For every table in the app schema, it queries `pg_policies` / `pg_class.relrowsecurity` /
`relforcerowsecurity` and asserts:

- the table has a `tenant_id` column,
- row-level security is **enabled and forced**,
- a policy exists whose `USING` _and_ `WITH CHECK` reference `current_setting('app.tenant_id')`.

A small explicit allowlist names the few legitimately tenant-less tables — as shipped:
`schema_migrations` (bookkeeping), `user_tenant_index` (sub→tenant routing, read before tenant context
exists), `webauthn_challenges` (ephemeral pre-auth ceremony state), `stripe_events` (global webhook dedup
log) — so they are an intentional, reviewed exception rather than a silent miss. `tenants` is special-cased
(isolated via `id`, so it skips only the `tenant_id`-column check). Result: adding a new tenant table without
RLS turns red in CI automatically — no per-table test to remember. This complements, and is referenced by,
the `/db-migration` skill.

## Files touched

- New: `apps/api/src/admin/admin.service.spec.ts`, `apps/api/src/users/user.service.spec.ts`,
  `apps/api/src/devices/devices.service.spec.ts`.
- New: `apps/api/src/db/rls-coverage.spec.ts` (+ a tiny, commented allowlist constant).
- Edit: `.claude/skills/db-migration/SKILL.md` — a one-line note pointing at the new guard.
- No production code, no schema, no endpoints change.

## Risks & what could break

- **Catalog query correctness.** The helper must read the same schema the app uses (search_path) and
  recognise `FORCE` RLS, not just `ENABLE`. Validate it flags a deliberately-broken policy in a scratch test.
- **Allowlist abuse.** The tenant-less allowlist must stay tiny and reviewed; growing it is the smell the
  guard exists to prevent. Keep it inline with a comment per entry.
- **CI gating.** The spec needs the live Postgres already used by CI (`describe.skipIf(!DATABASE_URL)`),
  so it must not run (and silently pass) when no DB is present — assert at least one table was checked.

## How to verify by hand

1. `pnpm --filter @argus/api test` — new service specs pass; `rls-coverage.spec.ts` passes against the
   migrated dev DB (`make up && make migrate`).
2. Temporarily drop a policy on a scratch table → the coverage spec turns **red** (proves it bites).
   Revert.
3. Confirm the spec reports a non-zero count of tables checked (guards against a no-op skip).

## Out of scope

Refactoring the services under test, or changing any RLS policy. This track only _observes_ and asserts.
