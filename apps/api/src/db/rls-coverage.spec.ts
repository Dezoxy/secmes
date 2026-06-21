import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Catalog-driven RLS coverage guard (AGENTS.md invariant #3). Instead of hand-listing tenant tables —
// which always lags the schema — this enumerates every ordinary table in `public` from the live catalog
// and asserts each one is tenant-isolated. A new table that ships without a forced `app.tenant_id` policy,
// or a typo in an existing `USING` / `WITH CHECK` clause, turns this red automatically. Pairs with the
// `/db-migration` skill, which generates the policy this guard then enforces.
//
// Requires a live Postgres with migrations applied:  make up && make migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job without a DB service).
const DB_URL = process.env.DATABASE_URL;

// Tables that legitimately do NOT carry an `app.tenant_id` RLS policy. Each MUST stay justified — growing
// this list is the exact smell the guard exists to catch, so every entry carries a reason and the
// "no stale entries" test below fails if one is ever dropped from the schema without being removed here.
const TENANTLESS_ALLOWLIST = new Map<string, string>([
  ['schema_migrations', 'migration bookkeeping — global, has no tenant dimension'],
  [
    'user_tenant_index',
    'sub→tenant routing table, read BEFORE tenant context exists (the auth bootstrap)',
  ],
  [
    'webauthn_challenges',
    'ephemeral pre-auth ceremony state; gated by a server-minted ceremony id, deleted on use',
  ],
  [
    'stripe_events',
    'global Stripe webhook dedup log — event id/type/timestamp only, no tenant_id, no PII',
  ],
]);

// The root tenant table is tenant-isolated via `id = current_setting('app.tenant_id')`, so it has the
// RLS policy but (correctly) no `tenant_id` column — the column check is skipped for it alone.
const TENANT_BY_ID = 'tenants';

// The canonical tenant-equality SHAPE (anchored) — deliberately NOT a loose `%app.tenant_id%` substring.
// A substring match would accept an inverted predicate (`tenant_id <> …`) or an appended `OR true`, both
// of which still *mention* the GUC while breaking isolation (Codex P2). This anchors the whole expression
// to `(<col> = …current_setting('app.tenant_id')…::uuid)`, so the operator must be `=` and nothing may be
// appended after the cast. It matches the two deparsed forms in use today —
//   (tenant_id = (current_setting('app.tenant_id'::text))::uuid)
//   (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
// If a future table ever splits enforcement across separate FOR INSERT / FOR SELECT policies, switch the
// count below to match USING and WITH CHECK independently.
const TENANT_ID_EQ_SHAPE = String.raw`^\(tenant_id = .*current_setting\('app\.tenant_id'.*\)::uuid\)$`;
// AGENTS.md requires isolation by `tenant_id`; only the root `tenants` table is keyed on `id`. The id-shape
// is therefore matched ONLY for `tenants` (Codex P2) — any OTHER table that isolated on its own `id` would
// fail the tenant_id-shape check and be flagged, not silently pass.
const TENANTS_ID_EQ_SHAPE = String.raw`^\(id = .*current_setting\('app\.tenant_id'.*\)::uuid\)$`;

// PostgreSQL OR-combines permissive policies, so a single tenant-shaped policy is NOT enough: a second
// app-visible policy (granted to argus_app or PUBLIC) with a permissive predicate — e.g. SELECT USING
// (true), the prune-role bypass class — would silently re-open cross-tenant reads (Codex P2; cf. #262).
// The guard therefore also fails on ANY app-visible policy whose USING/WITH CHECK is not the tenant shape,
// unless it is one of these explicitly-reviewed, row-scoped carve-outs. Cleanup/prune policies are granted
// to argus_cleanup / argus_prune (NOT app-visible) so they are out of scope here. Each entry is
// `<table>.<policyname>`; the "no stale carve-out" test below fails if one ever disappears.
const CARVE_OUT_POLICIES = new Set<string>([
  // Pre-tenant session refresh: a single row matched by app.session_refresh_hash, not a bulk read.
  'auth_sessions.auth_sessions_refresh_lookup',
  // Pre-tenant invite accept: a single row matched by app.invite_token_hash.
  'tenant_invites.tenant_invites_accept_flow',
  // Invite passkey consume: a single invite row matched by app.current_invite_id.
  'tenant_invites.tenant_invites_passkey_consume',
]);

interface TableRls {
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_id: boolean;
  tenant_policies: number;
  // App-visible (argus_app / PUBLIC) policies with a non-tenant-shaped USING or WITH CHECK — the
  // permissive-policy / OR-combine risk. Each must be in CARVE_OUT_POLICIES or it's a violation.
  app_visible_extra_policies: string[];
}

describe.skipIf(!DB_URL)('RLS coverage (catalog-driven)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let rows: TableRls[];

  beforeAll(async () => {
    sql = getDb().sql;
    const result = (await sql`
      select
        c.relname as table,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        exists(
          select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname
            and col.column_name = 'tenant_id'
        ) as has_tenant_id,
        -- Counts a single policy whose USING and WITH CHECK BOTH match the anchored tenant-equality
        -- shape — not a loose substring, so an inverted or permissive predicate that merely mentions
        -- the GUC does not count. The id-keyed shape is allowed ONLY for the tenants root; every
        -- other table must isolate on tenant_id.
        (
          select count(*) from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
            and p.qual ~* (case when c.relname = ${TENANT_BY_ID} then ${TENANTS_ID_EQ_SHAPE} else ${TENANT_ID_EQ_SHAPE} end)
            and p.with_check ~* (case when c.relname = ${TENANT_BY_ID} then ${TENANTS_ID_EQ_SHAPE} else ${TENANT_ID_EQ_SHAPE} end)
        )::int as tenant_policies,
        -- Any policy granted to argus_app or PUBLIC whose USING or WITH CHECK is present but NOT the
        -- tenant shape — i.e. could widen app visibility beyond the tenant. Cleanup/prune policies are
        -- granted to argus_cleanup / argus_prune and are excluded here. Filtered against CARVE_OUT_POLICIES.
        coalesce((
          select array_agg(p.policyname::text order by p.policyname)
          from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
            and p.roles && array['argus_app', 'public']::name[]
            and (
              (p.qual is not null and p.qual !~* (case when c.relname = ${TENANT_BY_ID} then ${TENANTS_ID_EQ_SHAPE} else ${TENANT_ID_EQ_SHAPE} end))
              or (p.with_check is not null and p.with_check !~* (case when c.relname = ${TENANT_BY_ID} then ${TENANTS_ID_EQ_SHAPE} else ${TENANT_ID_EQ_SHAPE} end))
            )
        ), array[]::text[]) as app_visible_extra_policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `) as unknown as TableRls[];
    rows = result;
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('enumerates a non-trivial number of tables (guards against a silent skip / wrong schema)', () => {
    const checked = rows.filter((r) => !TENANTLESS_ALLOWLIST.has(r.table));
    // 19 tenant-scoped tables exist today (18 via tenant_id + the tenants root). A floor of 14 leaves
    // headroom for legitimate removals while still turning red if the catalog query returns ~nothing.
    expect(checked.length).toBeGreaterThanOrEqual(14);
  });

  it('allowlist has no stale entries (every allowlisted table still exists)', () => {
    const present = new Set(rows.map((r) => r.table));
    const stale = [...TENANTLESS_ALLOWLIST.keys()].filter((t) => !present.has(t));
    expect(stale).toEqual([]);
  });

  it('every non-allowlisted table is tenant-isolated (ENABLE+FORCE RLS + an app.tenant_id policy)', () => {
    const violations: string[] = [];
    for (const r of rows) {
      if (TENANTLESS_ALLOWLIST.has(r.table)) continue;
      if (!r.rls_enabled) violations.push(`${r.table}: row-level security not ENABLED`);
      if (!r.rls_forced) violations.push(`${r.table}: row-level security not FORCED`);
      if (r.table !== TENANT_BY_ID && !r.has_tenant_id) {
        violations.push(`${r.table}: missing tenant_id column`);
      }
      if (r.tenant_policies < 1) {
        violations.push(
          `${r.table}: no policy whose USING and WITH CHECK both reference current_setting('app.tenant_id')`,
        );
      }
      // OR-combine guard: any app-visible policy that isn't tenant-shaped must be a reviewed carve-out.
      const extras = (r.app_visible_extra_policies ?? []).filter(
        (name) => !CARVE_OUT_POLICIES.has(`${r.table}.${name}`),
      );
      if (extras.length > 0) {
        violations.push(
          `${r.table}: app-visible policy not tenant-scoped and not in CARVE_OUT_POLICIES: ${extras.join(', ')}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('carve-out allowlist has no stale entries (each is still a present app-visible policy)', () => {
    const present = new Set(
      rows.flatMap((r) => (r.app_visible_extra_policies ?? []).map((name) => `${r.table}.${name}`)),
    );
    const stale = [...CARVE_OUT_POLICIES].filter((entry) => !present.has(entry));
    expect(stale).toEqual([]);
  });
});
