import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/index.js';
import { AuditService } from './audit.service.js';

// Integration — proves audit_events is tenant-isolated and append-only (roadmap 16).
// Needs a live Postgres with migrations applied; auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('AuditService + audit_events', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const audit = new AuditService();

  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Audit-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Audit-B') returning id`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades audit rows
      await sql.end({ timeout: 5 });
    }
  });

  it('records an event in the verified tenant context (app role can INSERT)', async () => {
    await audit.record(tenantA, {
      eventType: 'auth.login',
      actorSub: 'sub-a',
      ip: '203.0.113.7',
      userAgent: 'UA/1',
    });
    const rows = (await asTenant(
      tenantA,
      (tx) => tx`select event_type, actor_sub from audit_events`,
    )) as Array<{ event_type: string; actor_sub: string }>;
    expect(rows).toEqual([{ event_type: 'auth.login', actor_sub: 'sub-a' }]);
  });

  it("a tenant cannot read another tenant's audit rows", async () => {
    const rows = (await asTenant(tenantB, (tx) => tx`select id from audit_events`)) as unknown[];
    expect(rows.length).toBe(0);
  });

  it('is append-only: the app role cannot UPDATE or DELETE (42501 insufficient_privilege)', async () => {
    // Assert the SPECIFIC permission error, so the test can't pass for an unrelated reason.
    await expect(
      asTenant(tenantA, (tx) => tx`update audit_events set event_type = 'tampered'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant(tenantA, (tx) => tx`delete from audit_events`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
