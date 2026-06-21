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

interface TableRls {
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_id: boolean;
  tenant_policies: number;
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
        -- Counts a single policy carrying the tenant predicate in BOTH USING and WITH CHECK (the
        -- FOR ALL isolation policy every tenant table uses today). If a future table ever splits
        -- enforcement across separate FOR INSERT / FOR SELECT policies, change this to count USING
        -- refs and WITH CHECK refs independently so the split case is not a false positive.
        (
          select count(*) from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
            and p.qual ilike '%app.tenant_id%' and p.with_check ilike '%app.tenant_id%'
        )::int as tenant_policies
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
    }
    expect(violations).toEqual([]);
  });
});
