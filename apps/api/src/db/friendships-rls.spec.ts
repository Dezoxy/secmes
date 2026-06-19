import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself isolates `friendships` by tenant (invariant #3), and that
// the dedicated argus_cleanup role can reap ONLY expired pending rows (never live pending, never accepted
// friendships — the recovered contact list must survive the TTL sweep). Mirrors attachments-rls.spec.ts.
// Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
//
// Note: the caller-is-a-member confinement (a user only sees friendships they are a party to) is enforced
// at the application layer in FriendsService, NOT by RLS — see 0042_friendships.sql. This spec covers the
// DB-level guarantees the migration ships: tenant isolation + the cleanup-role posture.
//
// Tenant A gets THREE users → three distinct canonical pairs (1,2),(1,3),(2,3), enough to seed an
// accepted + a live-pending + an expired-pending row at once (the unique (tenant,low,high) constraint
// allows one row per pair). Tenant B gets two users (one pair) for the cross-tenant assertions.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('friendships schema RLS + cleanup posture', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let a1: string;
  let a2: string;
  let a3: string;
  let b1: string;
  let b2: string;

  // Same shape as the app's withTenant(): non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // The TTL-sweep worker's posture: the dedicated argus_cleanup role, with NO app.tenant_id set — it
  // sweeps ACROSS tenants, and its RLS policy exposes ONLY expired pending rows.
  function asCleanup(fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_cleanup`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // Insert a friendship under `tenant` between two users, respecting the migration's CHECK constraints:
  //   pending  → expires_at + requested_by required; accepted → both NULL.
  // Canonical (user_low_id < user_high_id) is computed in SQL with least()/greatest(), so call order
  // does not matter. `expiresInDays` only applies to pending rows: negative = already expired, positive
  // = live. Returns the new row id (inserted via the owner connection, which bypasses RLS).
  function makeFriendship(
    tenant: string,
    ua: string,
    ub: string,
    status: 'pending' | 'accepted',
    expiresInDays = 1,
  ): Promise<string> {
    if (status === 'accepted') {
      return sql`insert into friendships (tenant_id, user_low_id, user_high_id, status, resolved_at)
                 values (${tenant}, least(${ua}, ${ub})::uuid, greatest(${ua}, ${ub})::uuid, 'accepted', now())
                 returning id`.then((rows) => (rows[0] as { id: string }).id);
    }
    return sql`insert into friendships (tenant_id, user_low_id, user_high_id, status, requested_by, expires_at)
               values (${tenant}, least(${ua}, ${ub})::uuid, greatest(${ua}, ${ub})::uuid, 'pending',
                       least(${ua}, ${ub})::uuid, now() + make_interval(days => ${expiresInDays}))
               returning id`.then((rows) => (rows[0] as { id: string }).id);
  }

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] =
      await sql`insert into tenants (name) values ('Fr RLS Tenant A') returning id`;
    [{ id: tenantB }] =
      await sql`insert into tenants (name) values ('Fr RLS Tenant B') returning id`;
    const mkUser = async (tenant: string, ext: string): Promise<string> => {
      const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                            values (${tenant}, ${ext}, ${`${ext}@t.test`}) returning id`;
      return (u as { id: string }).id;
    };
    a1 = await mkUser(tenantA, 'frrls-a1');
    a2 = await mkUser(tenantA, 'frrls-a2');
    a3 = await mkUser(tenantA, 'frrls-a3');
    b1 = await mkUser(tenantB, 'frrls-b1');
    b2 = await mkUser(tenantB, 'frrls-b2');
  });

  beforeEach(async () => {
    await sql`delete from friendships where tenant_id in (${tenantA}, ${tenantB})`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades users + friendships
      await sql.end({ timeout: 5 });
    }
  });

  it('a tenant reads only its own friendships', async () => {
    await makeFriendship(tenantA, a1, a2, 'accepted');
    await makeFriendship(tenantB, b1, b2, 'accepted');
    const seen = (await asTenant(tenantA, (tx) => tx`select tenant_id from friendships`)) as Array<{
      tenant_id: string;
    }>;
    expect(seen.length).toBe(1);
    expect(seen.every((r) => r.tenant_id === tenantA)).toBe(true); // B's rows are invisible to A
  });

  it('WITH CHECK blocks writing a friendship into another tenant', async () => {
    // Tenant A (RLS-valid context) names tenant B in the row — the WITH CHECK rejects the write.
    await expect(
      asTenant(
        tenantA,
        (tx) =>
          tx`insert into friendships (tenant_id, user_low_id, user_high_id, status, resolved_at)
             values (${tenantB}, least(${b1}, ${b2})::uuid, greatest(${b1}, ${b2})::uuid, 'accepted', now())`,
      ),
    ).rejects.toThrow();
  });

  it('composite FK blocks referencing a user from another tenant', async () => {
    // Tenant B (RLS-valid tenant_id) names a tenant-A user — (B, a1) is not in users(tenant_id, id),
    // so the composite FK rejects the write (closes the cross-tenant party bind).
    await expect(
      asTenant(
        tenantB,
        (tx) =>
          tx`insert into friendships (tenant_id, user_low_id, user_high_id, status, resolved_at)
             values (${tenantB}, least(${a1}, ${b1})::uuid, greatest(${a1}, ${b1})::uuid, 'accepted', now())`,
      ),
    ).rejects.toThrow();
  });

  it('no tenant context => fail closed (zero rows) on friendships', async () => {
    // Unlike attachments (which throws), this policy uses the nullif/missing_ok guard: with no
    // app.tenant_id set, `tenant_id = NULL` evaluates to NULL → the row is filtered out. Fail-closed
    // by exposing nothing, not by erroring.
    await makeFriendship(tenantA, a1, a2, 'accepted');
    const rows = (await sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      return tx`select id from friendships`;
    })) as Array<{ id: string }>;
    expect(rows.length).toBe(0);
  });

  it('argus_cleanup sees only EXPIRED PENDING rows, across tenants', async () => {
    const accepted = await makeFriendship(tenantA, a1, a2, 'accepted'); // A: accepted
    const livePending = await makeFriendship(tenantA, a1, a3, 'pending', 1); // A: live pending
    const expiredA = await makeFriendship(tenantA, a2, a3, 'pending', -1); // A: expired pending
    const expiredB = await makeFriendship(tenantB, b1, b2, 'pending', -1); // B: expired pending

    // The cleanup role has column-level SELECT on (id, expires_at) only — it cannot read `status`.
    // The cleanup_select policy already restricts visibility to expired pending rows, so any row the
    // role can see is, by construction, an expired pending one.
    const seen = (await asCleanup((tx) => tx`select id from friendships`)) as Array<{ id: string }>;
    const ids = seen.map((r) => r.id);

    expect(ids).toContain(expiredA);
    expect(ids).toContain(expiredB); // cross-tenant reap — no app.tenant_id set
    expect(ids).not.toContain(livePending); // live pending invisible to cleanup
    expect(ids).not.toContain(accepted); // accepted friendship invisible to cleanup
  });

  it('argus_cleanup deletes an expired pending row but cannot touch a live or accepted one', async () => {
    const expired = await makeFriendship(tenantA, a1, a2, 'pending', -1); // expired pending
    const live = await makeFriendship(tenantA, a1, a3, 'pending', 1); // live pending
    const accepted = await makeFriendship(tenantA, a2, a3, 'accepted'); // accepted

    await asCleanup((tx) => tx`delete from friendships where id = ${expired}`); // reaped
    await asCleanup((tx) => tx`delete from friendships where id = ${live}`); // RLS hides it → 0 rows
    await asCleanup((tx) => tx`delete from friendships where id = ${accepted}`); // RLS hides it → 0 rows

    const [g] = await sql`select count(*)::int as n from friendships where id = ${expired}`;
    const [l] = await sql`select count(*)::int as n from friendships where id = ${live}`;
    const [acc] = await sql`select count(*)::int as n from friendships where id = ${accepted}`;
    expect((g as { n: number }).n).toBe(0); // expired pending gone
    expect((l as { n: number }).n).toBe(1); // live pending survived — cleanup could not see it
    expect((acc as { n: number }).n).toBe(1); // accepted friendship survived
  });

  it('argus_cleanup has column-scoped SELECT: it cannot read status (only id, expires_at)', async () => {
    await makeFriendship(tenantA, a1, a2, 'pending', -1); // an expired pending row the role CAN see
    // Pins the migration's `GRANT SELECT (id, expires_at)` — widening the cleanup grant to all
    // columns later would make this throw stop, failing the test.
    await expect(asCleanup((tx) => tx`select status from friendships`)).rejects.toThrow();
    await expect(asCleanup((tx) => tx`select expires_at from friendships`)).resolves.toBeDefined();
  });

  it('argus_cleanup is reap-only: it cannot INSERT or UPDATE friendships', async () => {
    const id = await makeFriendship(tenantA, a1, a2, 'pending', -1);
    await expect(
      asCleanup((tx) => tx`update friendships set status = 'accepted' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      asCleanup(
        (tx) =>
          tx`insert into friendships (tenant_id, user_low_id, user_high_id, status, requested_by, expires_at)
             values (${tenantA}, least(${a1}, ${a3})::uuid, greatest(${a1}, ${a3})::uuid, 'pending',
                     least(${a1}, ${a3})::uuid, now())`,
      ),
    ).rejects.toThrow();
  });
});
