import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself isolates `attachments` by tenant, pins the uploader to the
// row tenant, preserves history on a user delete (NO ACTION), and lets the app PRUNE attachments
// (checkpoint 35). Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('attachments schema RLS + lifecycle (checkpoint 35)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;

  // Same shape as the app's withTenant(): non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // Insert an attachment under `tenant`/`user`; returns the new id.
  function makeAttachment(tenant: string, user: string, key: string): Promise<string> {
    return asTenant(tenant, async (tx) => {
      const [row] = await tx`insert into attachments (tenant_id, object_key, byte_size, uploaded_by)
                             values (${tenant}, ${key}, 2048, ${user}) returning id`;
      return (row as { id: string }).id;
    }) as Promise<string>;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Att Tenant A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Att Tenant B') returning id`;
    [{ id: userA }] = await sql`insert into users (tenant_id, external_identity_id, email)
                                values (${tenantA}, 'att-ext-a', 'att-a@a.test') returning id`;
    [{ id: userB }] = await sql`insert into users (tenant_id, external_identity_id, email)
                                values (${tenantB}, 'att-ext-b', 'att-b@b.test') returning id`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades attachments
      await sql.end({ timeout: 5 });
    }
  });

  it('a tenant reads only its own attachments', async () => {
    await makeAttachment(tenantA, userA, `${tenantA}/a1`);
    await makeAttachment(tenantB, userB, `${tenantB}/b1`);
    const seen = (await asTenant(
      tenantA,
      (tx) => tx`select tenant_id, object_key from attachments`,
    )) as Array<{ tenant_id: string; object_key: string }>;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(seen.some((r) => r.object_key === `${tenantB}/b1`)).toBe(false); // B's row is invisible to A
  });

  it('WITH CHECK blocks writing an attachment into another tenant', async () => {
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into attachments (tenant_id, object_key, byte_size, uploaded_by)
                   values (${tenantB}, ${`${tenantB}/x`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('composite FK blocks referencing a user from another tenant', async () => {
    // tenant B (RLS-valid tenant_id) names tenant A's user as uploaded_by — (B, userA) is not in
    // users(tenant_id, id), so the composite FK rejects the write.
    await expect(
      asTenant(
        tenantB,
        (tx) => tx`insert into attachments (tenant_id, object_key, byte_size, uploaded_by)
                   values (${tenantB}, ${`${tenantB}/x`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive byte_size (check constraint)', async () => {
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into attachments (tenant_id, object_key, byte_size, uploaded_by)
                   values (${tenantA}, ${`${tenantA}/zero`}, 0, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (tenant_id, object_key)', async () => {
    const key = `${tenantA}/dup`;
    await makeAttachment(tenantA, userA, key);
    await expect(makeAttachment(tenantA, userA, key)).rejects.toThrow();
  });

  it('is PRUNABLE: the app role can delete its own attachment (unlike append-only messages)', async () => {
    const id = await makeAttachment(tenantA, userA, `${tenantA}/prune`);
    await asTenant(tenantA, (tx) => tx`delete from attachments where id = ${id}`); // must NOT throw
    const [row] = (await asTenant(
      tenantA,
      (tx) => tx`select count(*)::int as n from attachments where id = ${id}`,
    )) as Array<{ n: number }>;
    expect((row as { n: number }).n).toBe(0);
  });

  it('preserves history: deleting a user with attachments is blocked (NO ACTION, not cascade)', async () => {
    await makeAttachment(tenantA, userA, `${tenantA}/hist`);
    await expect(
      asTenant(tenantA, (tx) => tx`delete from users where id = ${userA}`),
    ).rejects.toThrow();
  });

  it('a tenant teardown still cascades its attachments (NO ACTION does not block it)', async () => {
    const [t] = await sql`insert into tenants (name) values ('Att Teardown') returning id`;
    const tid = (t as { id: string }).id;
    const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                          values (${tid}, 'att-td', 'td@t.test') returning id`;
    await makeAttachment(tid, (u as { id: string }).id, `${tid}/k`);
    await sql`delete from tenants where id = ${tid}`; // must not throw — cascades everything
    const [row] = await sql`select count(*)::int as n from attachments where tenant_id = ${tid}`;
    expect((row as { n: number }).n).toBe(0);
  });

  it('no tenant context => fail closed on attachments', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role argus_app`;
        return tx`select count(*) from attachments`;
      }),
    ).rejects.toThrow();
  });
});
