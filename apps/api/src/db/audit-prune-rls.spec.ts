import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself enforces the audit/session retention prune (review finding
// F1/AR-1, migration 0043). The dedicated argus_prune role may SELECT + DELETE ONLY rows past their
// retention window — across tenants, but never an in-window row — while the app role's tenant isolation on
// audit_events is unchanged by the policy re-scope, and the append-only boundary now permits a column-scoped
// metadata UPDATE (ER-1) while still forbidding any rewrite of the integrity columns. Mirrors
// friendships-rls.spec.ts / attachments-rls.spec.ts. Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
//
// Windows: audit_events prunes created_at < now() - 90 days; auth_sessions prunes expires_at < now() - 30
// days. We assert on specific seeded row ids (contain / not-contain), never on cross-tenant counts, so other
// suites' rows can't perturb the result.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('audit/session retention prune (argus_prune) — F1/AR-1', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let seq = 0;

  // The app's withTenant(): non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // The prune worker's posture: the dedicated argus_prune role, NO app.tenant_id set — it sweeps ACROSS
  // tenants, and its RLS policies expose + allow DELETE on ONLY past-window rows.
  function asPrune(fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_prune`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // Owner inserts (bypass RLS). `ageDays` > 0 means created that many days in the PAST.
  function mkAudit(tenant: string, ageDays: number): Promise<string> {
    return sql`insert into audit_events (tenant_id, event_type, created_at)
               values (${tenant}, 'test.event', now() - make_interval(days => ${ageDays}))
               returning id`.then((rows) => (rows[0] as { id: string }).id);
  }

  // `expiresInDays` < 0 means expired that many days AGO; > 0 means still live.
  function mkSession(tenant: string, userId: string, expiresInDays: number): Promise<string> {
    seq += 1;
    const hash = `prune-spec-${Date.now()}-${seq}`; // refresh_token_hash is UNIQUE
    return sql`insert into auth_sessions (tenant_id, user_id, sub, refresh_token_hash, expires_at)
               values (${tenant}, ${userId}, 'argusid:test', ${hash},
                       now() + make_interval(days => ${expiresInDays}))
               returning id`.then((rows) => (rows[0] as { id: string }).id);
  }

  const countAudit = async (id: string): Promise<number> =>
    ((await sql`select count(*)::int as n from audit_events where id = ${id}`)[0] as { n: number })
      .n;
  const countSession = async (id: string): Promise<number> =>
    ((await sql`select count(*)::int as n from auth_sessions where id = ${id}`)[0] as { n: number })
      .n;

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Prune RLS A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Prune RLS B') returning id`;
    const mkUser = async (tenant: string, ext: string): Promise<string> => {
      const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                            values (${tenant}, ${ext}, ${`${ext}@t.test`}) returning id`;
      return (u as { id: string }).id;
    };
    userA = await mkUser(tenantA, 'prune-a1');
    userB = await mkUser(tenantB, 'prune-b1');
  });

  beforeEach(async () => {
    await sql`delete from audit_events where tenant_id in (${tenantA}, ${tenantB})`;
    await sql`delete from auth_sessions where tenant_id in (${tenantA}, ${tenantB})`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades users + rows
      await sql.end({ timeout: 5 });
    }
  });

  it('argus_prune sees only past-window audit rows, across tenants', async () => {
    const oldA = await mkAudit(tenantA, 100); // > 90d → prunable
    const recentA = await mkAudit(tenantA, 10); // < 90d → in-window
    const oldB = await mkAudit(tenantB, 100); // other tenant, > 90d → prunable

    const seen = (await asPrune((tx) => tx`select id from audit_events`)) as Array<{ id: string }>;
    const ids = seen.map((r) => r.id);
    expect(ids).toContain(oldA);
    expect(ids).toContain(oldB); // cross-tenant — no app.tenant_id set
    expect(ids).not.toContain(recentA); // in-window row invisible to the prune role
  });

  it('argus_prune deletes past-window audit rows of both tenants but cannot touch an in-window one', async () => {
    const oldA = await mkAudit(tenantA, 100);
    const recentA = await mkAudit(tenantA, 10);
    const oldB = await mkAudit(tenantB, 100);

    await asPrune((tx) => tx`delete from audit_events where id = ${oldA}`); // reaped
    await asPrune((tx) => tx`delete from audit_events where id = ${oldB}`); // reaped (cross-tenant)
    await asPrune((tx) => tx`delete from audit_events where id = ${recentA}`); // RLS hides it → 0 rows

    expect(await countAudit(oldA)).toBe(0);
    expect(await countAudit(oldB)).toBe(0);
    expect(await countAudit(recentA)).toBe(1); // in-window row survived — prune could not see it
  });

  it('argus_prune deletes sessions expired > 30d but keeps recently-expired and live ones', async () => {
    const stale = await mkSession(tenantA, userA, -40); // expired 40d ago → prunable
    const recentlyExpired = await mkSession(tenantA, userA, -10); // expired 10d ago → forensics window
    const live = await mkSession(tenantA, userA, 5); // still valid
    const staleB = await mkSession(tenantB, userB, -40); // other tenant, prunable

    await asPrune((tx) => tx`delete from auth_sessions where id = ${stale}`);
    await asPrune((tx) => tx`delete from auth_sessions where id = ${staleB}`);
    await asPrune((tx) => tx`delete from auth_sessions where id = ${recentlyExpired}`); // RLS → 0 rows
    await asPrune((tx) => tx`delete from auth_sessions where id = ${live}`); // RLS → 0 rows

    expect(await countSession(stale)).toBe(0);
    expect(await countSession(staleB)).toBe(0);
    expect(await countSession(recentlyExpired)).toBe(1); // within the 30-day reuse-detection buffer
    expect(await countSession(live)).toBe(1);
  });

  it('argus_app tenant isolation on audit_events is unchanged by the policy re-scope', async () => {
    await mkAudit(tenantA, 1);
    await mkAudit(tenantB, 1);
    const seen = (await asTenant(
      tenantA,
      (tx) => tx`select tenant_id from audit_events`,
    )) as Array<{ tenant_id: string }>;
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((r) => r.tenant_id === tenantA)).toBe(true); // B's rows invisible to A
  });

  it('audit is append-only EXCEPT a column-scoped metadata UPDATE (ER-1): integrity columns stay immutable', async () => {
    const id = await mkAudit(tenantA, 1);
    // ER-1: the app may scrub metadata (the targetArgusId erasure) — column-scoped grant from 0043.
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`update audit_events set metadata = '{"scrubbed":true}'::jsonb where id = ${id}`,
      ),
    ).resolves.toBeDefined();
    // But the integrity columns the append-only design protects must remain non-updatable (no column grant)
    // — so a cover-up / log-forgery rewrite still fails.
    await expect(
      asTenant(tenantA, (tx) => tx`update audit_events set event_type = 'tamper' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      asTenant(tenantA, (tx) => tx`update audit_events set actor_sub = 'spoof' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      asTenant(tenantA, (tx) => tx`update audit_events set created_at = now() where id = ${id}`),
    ).rejects.toThrow();
  });
});
