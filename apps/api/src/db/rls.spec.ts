import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself blocks cross-tenant access (roadmap checkpoint 12).
// Requires a live Postgres with migrations applied:  make up && pnpm --filter @secmes/api db:migrate
// Auto-skips where no DATABASE_URL is set (e.g. the unit-only CI job without a DB service).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('RLS tenant isolation', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;

  // Run `fn` exactly as the app's withTenant() does: non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role secmes_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    // Seed as the owner connection (superuser locally → bypasses RLS for setup only).
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Tenant A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Tenant B') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email)
              values (${tenantA}, 'ext-a', 'a@a.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email)
              values (${tenantB}, 'ext-b', 'b@b.test')`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades users
      await sql.end({ timeout: 5 });
    }
  });

  it('a tenant reads only its own users', async () => {
    const rows = (await asTenant(
      tenantA,
      (tx) => tx`select tenant_id, email from users`,
    )) as Array<{ tenant_id: string; email: string }>;
    expect(rows.map((r) => r.email)).toEqual(['a@a.test']);
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it('a tenant reads only its own tenants row', async () => {
    const rows = (await asTenant(tenantA, (tx) => tx`select id from tenants`)) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual([tenantA]);
  });

  it('WITH CHECK blocks writing a row into another tenant', async () => {
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into users (tenant_id, external_identity_id, email)
                   values (${tenantB}, 'evil', 'evil@x.test')`,
      ),
    ).rejects.toThrow();
  });

  it('no tenant context => fail closed (never reads all rows)', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role secmes_app`;
        return tx`select count(*) from users`;
      }),
    ).rejects.toThrow();
  });

  // The threat model's #1 risk: residual tenant context surviving on a REUSED pooled connection.
  it('pooled connection reuse leaks no context — A then B then a bare query, same socket', async () => {
    const pinned = postgres(DB_URL as string, { max: 1 }); // max:1 forces the same connection each time
    try {
      const ownerRows = (await pinned`select current_user as who`) as unknown as {
        who: string;
      }[];
      const owner = ownerRows[0]?.who;

      const a = (await pinned.begin(async (tx) => {
        await tx`set local role secmes_app`;
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx`select email from users`;
      })) as unknown as { email: string }[];
      const b = (await pinned.begin(async (tx) => {
        await tx`set local role secmes_app`;
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        return tx`select email from users`;
      })) as unknown as { email: string }[];
      expect(a.map((r) => r.email)).toEqual(['a@a.test']);
      expect(b.map((r) => r.email)).toEqual(['b@b.test']);

      // After both tx commit, the reused connection must retain no residual role or tenant var.
      const afterRows = (await pinned`
        select current_user as who, current_setting('app.tenant_id', true) as tid`) as unknown as {
        who: string;
        tid: string | null;
      }[];
      const after = afterRows[0];
      expect(after?.who).toBe(owner); // role reset off secmes_app
      expect(after?.tid).toBeFalsy(); // tenant var gone — not tenantA/tenantB
    } finally {
      await pinned.end({ timeout: 5 });
    }
  });

  it('the app role cannot disable RLS (no privilege escalation)', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role secmes_app`;
        return tx`alter table users disable row level security`;
      }),
    ).rejects.toThrow();
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role secmes_app`;
        return tx`alter table users no force row level security`;
      }),
    ).rejects.toThrow();
  });
});
