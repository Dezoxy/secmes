import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself isolates `attachments` by tenant, pins BOTH the owning
// conversation and the uploader to the row tenant, preserves history on a user delete (NO ACTION), and
// lets the app PRUNE attachments (checkpoint 35). Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('attachments schema RLS + lifecycle (checkpoint 35)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let convA: string; // a conversation owned by tenant A
  let convB: string; // a conversation owned by tenant B

  // Same shape as the app's withTenant(): non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  function makeConversation(tenant: string, user: string): Promise<string> {
    return asTenant(tenant, async (tx) => {
      const [c] = await tx`insert into conversations (tenant_id, created_by)
                           values (${tenant}, ${user}) returning id`;
      return (c as { id: string }).id;
    }) as Promise<string>;
  }

  // The standalone cleanup worker's posture (checkpoint 37): the dedicated argus_cleanup role, with NO
  // app.tenant_id set — it sweeps ACROSS tenants, and its RLS policy exposes ONLY rows whose retention lapsed.
  function asCleanup(fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_cleanup`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  // Insert an attachment under `tenant`, bound to `conv`, uploaded by `user`; returns the new id. Pass
  // `expiresInDays` to exercise the lifecycle/cleanup path: negative = already expired, positive = live,
  // null = never expires. Computed in SQL (now() + make_interval) — the same way the service sets it.
  function makeAttachment(
    tenant: string,
    conv: string,
    user: string,
    key: string,
    expiresInDays: number | null = null,
  ): Promise<string> {
    return asTenant(tenant, async (tx) => {
      const expiry =
        expiresInDays === null ? tx`null` : tx`now() + make_interval(days => ${expiresInDays})`;
      const [row] =
        await tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by, expires_at)
                             values (${tenant}, ${conv}, ${key}, 2048, ${user}, ${expiry}) returning id`;
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
    convA = await makeConversation(tenantA, userA);
    convB = await makeConversation(tenantB, userB);
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades attachments
      await sql.end({ timeout: 5 });
    }
  });

  it('a tenant reads only its own attachments', async () => {
    await makeAttachment(tenantA, convA, userA, `${tenantA}/a1`);
    await makeAttachment(tenantB, convB, userB, `${tenantB}/b1`);
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
        (
          tx,
        ) => tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
                   values (${tenantB}, ${convB}, ${`${tenantB}/x`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('composite FK blocks binding to a conversation in another tenant', async () => {
    // tenant B (RLS-valid tenant_id) names tenant A's conversation as the owner — (B, convA) is not in
    // conversations(tenant_id, id), so the composite FK rejects the write (closes the cross-tenant bind).
    await expect(
      asTenant(
        tenantB,
        (
          tx,
        ) => tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
                   values (${tenantB}, ${convA}, ${`${tenantB}/x`}, 1, ${userB})`,
      ),
    ).rejects.toThrow();
  });

  it('composite FK blocks referencing a user from another tenant', async () => {
    await expect(
      asTenant(
        tenantB,
        (
          tx,
        ) => tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
                   values (${tenantB}, ${convB}, ${`${tenantB}/x`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive byte_size (check constraint)', async () => {
    await expect(
      asTenant(
        tenantA,
        (
          tx,
        ) => tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
                   values (${tenantA}, ${convA}, ${`${tenantA}/zero`}, 0, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a duplicate object_key (GLOBAL unique — the blob store is outside RLS)', async () => {
    const key = `${tenantA}/dup`;
    await makeAttachment(tenantA, convA, userA, key);
    await expect(makeAttachment(tenantA, convA, userA, key)).rejects.toThrow();
  });

  it('object_key must be prefixed with the row tenant (CHECK — structural blob isolation)', async () => {
    // tenant A (RLS-valid) tries to claim a key in tenant B's namespace — the prefix CHECK rejects it,
    // so the app's tenant-prefixing fails closed even if the presign path had a bug.
    await expect(
      asTenant(
        tenantA,
        (tx) =>
          tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
             values (${tenantA}, ${convA}, ${`${tenantB}/x`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('is PRUNABLE: the app role can delete its own attachment (unlike append-only messages)', async () => {
    const id = await makeAttachment(tenantA, convA, userA, `${tenantA}/prune`);
    await asTenant(tenantA, (tx) => tx`delete from attachments where id = ${id}`); // must NOT throw
    const [row] = (await asTenant(
      tenantA,
      (tx) => tx`select count(*)::int as n from attachments where id = ${id}`,
    )) as Array<{ n: number }>;
    expect((row as { n: number }).n).toBe(0);
  });

  it('deleting the owning conversation cascade-deletes its attachments', async () => {
    // Conversations aren't app-deletable (no DELETE grant to argus_app); the FK cascade is proven via an
    // owner delete. In practice this fires on tenant teardown / a future owner conversation-delete path.
    const cid = await makeConversation(tenantA, userA);
    await makeAttachment(tenantA, cid, userA, `${tenantA}/conv-cascade`);
    await sql`delete from conversations where id = ${cid}`; // owner delete → FK cascade
    const [row] =
      await sql`select count(*)::int as n from attachments where conversation_id = ${cid}`;
    expect((row as { n: number }).n).toBe(0);
  });

  it('preserves history: deleting a user with attachments is blocked (NO ACTION, not cascade)', async () => {
    await makeAttachment(tenantA, convA, userA, `${tenantA}/hist`);
    await expect(
      asTenant(tenantA, (tx) => tx`delete from users where id = ${userA}`),
    ).rejects.toThrow();
  });

  it('a tenant teardown still cascades its attachments (NO ACTION does not block it)', async () => {
    const [t] = await sql`insert into tenants (name) values ('Att Teardown') returning id`;
    const tid = (t as { id: string }).id;
    const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                          values (${tid}, 'att-td', 'td@t.test') returning id`;
    const uid = (u as { id: string }).id;
    const cid = await makeConversation(tid, uid);
    await makeAttachment(tid, cid, uid, `${tid}/k`);
    await sql`delete from tenants where id = ${tid}`; // must not throw — cascades everything
    const [row] = await sql`select count(*)::int as n from attachments where tenant_id = ${tid}`;
    expect((row as { n: number }).n).toBe(0);
  });

  it('argus_cleanup sees EXPIRED rows across tenants, never live ones (checkpoint 37)', async () => {
    await makeAttachment(tenantA, convA, userA, `${tenantA}/cl-live`, 1); // live (expires in 1 day)
    await makeAttachment(tenantA, convA, userA, `${tenantA}/cl-exp-a`, -1); // expired 1 day ago
    await makeAttachment(tenantB, convB, userB, `${tenantB}/cl-exp-b`, -1); // expired, other tenant
    const seen = (await asCleanup((tx) => tx`select object_key from attachments`)) as Array<{
      object_key: string;
    }>;
    const keys = seen.map((r) => r.object_key);
    expect(keys).toContain(`${tenantA}/cl-exp-a`);
    expect(keys).toContain(`${tenantB}/cl-exp-b`); // cross-tenant reap — no app.tenant_id set
    expect(keys).not.toContain(`${tenantA}/cl-live`); // a live row is invisible to the cleanup role
  });

  it('argus_cleanup deletes an expired row but cannot touch a live one', async () => {
    const expId = await makeAttachment(tenantA, convA, userA, `${tenantA}/cl-del-exp`, -1);
    const liveId = await makeAttachment(tenantA, convA, userA, `${tenantA}/cl-del-live`, 1);
    await asCleanup((tx) => tx`delete from attachments where id = ${expId}`); // reaped
    await asCleanup((tx) => tx`delete from attachments where id = ${liveId}`); // RLS hides it → 0 rows
    const [g] = await sql`select count(*)::int as n from attachments where id = ${expId}`;
    const [l] = await sql`select count(*)::int as n from attachments where id = ${liveId}`;
    expect((g as { n: number }).n).toBe(0); // expired row gone
    expect((l as { n: number }).n).toBe(1); // live row survived — cleanup could not see it
  });

  it('argus_cleanup is reap-only: it cannot INSERT or UPDATE attachments', async () => {
    const id = await makeAttachment(tenantA, convA, userA, `${tenantA}/cl-noupd`, -1);
    await expect(
      asCleanup((tx) => tx`update attachments set byte_size = 1 where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      asCleanup(
        (
          tx,
        ) => tx`insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
                   values (${tenantA}, ${convA}, ${`${tenantA}/cl-ins`}, 1, ${userA})`,
      ),
    ).rejects.toThrow();
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
