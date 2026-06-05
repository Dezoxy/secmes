import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../audit/audit.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { KeyDirectoryService } from './key-directory.service.js';

// Integration (roadmap 19) — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('KeyDirectoryService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let bobId: string;
  const dir = new KeyDirectoryService(new AuditService());

  let aliceAuth: VerifiedAuth;
  let bobAuth: VerifiedAuth;
  let carolAuth: VerifiedAuth;
  let daveAuth: VerifiedAuth;

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('KD-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('KD-B') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-alice', 'al@a.test')`;
    [{ id: bobId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-bob', 'bob@a.test') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'kd-carol', 'c@b.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-dave', 'dave@a.test')`;

    aliceAuth = { sub: 'kd-alice', tenantId: tenantA };
    bobAuth = { sub: 'kd-bob', tenantId: tenantA };
    carolAuth = { sub: 'kd-carol', tenantId: tenantB };
    daveAuth = { sub: 'kd-dave', tenantId: tenantA };
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades devices/key_packages/users
      await sql.end({ timeout: 5 });
    }
  });

  it('publishes the caller device + KeyPackages, bound to the caller', async () => {
    const res = await dir.publish(bobAuth, 'Qk9CU0lH', ['a2V5LTE=', 'a2V5LTI=']);
    expect(res.published).toBe(2);
    const [d] = await sql`select user_id from devices where id = ${res.deviceId}`;
    expect(d?.user_id).toBe(bobId); // device is bound to Bob's verified identity
  });

  it('claims one-time-use packages, returns the device identity, then reports empty', async () => {
    const c1 = await dir.claim(aliceAuth, bobId);
    const c2 = await dir.claim(aliceAuth, bobId);
    expect(c1?.keyPackage).toBeTruthy();
    expect(c2?.keyPackage).toBeTruthy();
    expect(c1?.keyPackage).not.toBe(c2?.keyPackage); // distinct — never reused
    expect(c1?.signaturePublicKey).toBe('Qk9CU0lH'); // device sig key for fingerprint verification
    expect(await dir.claim(aliceAuth, bobId)).toBeNull(); // pool empty — no silent reuse
  });

  it('cannot claim across tenants (RLS)', async () => {
    await dir.publish(bobAuth, 'Qk9CU0lH', ['a2V5LXg=']); // refill Bob's pool
    // Carol is in tenant B; claiming for a tenant-A user is invisible under RLS.
    expect(await dir.claim(carolAuth, bobId)).toBeNull();
  });

  it('audits each successful claim (pool-drain detectability)', async () => {
    const [row] = await sql`
      select count(*)::int as n from audit_events
      where tenant_id = ${tenantA} and event_type = 'keydir.key_package_claimed'`;
    expect(row?.n).toBeGreaterThanOrEqual(2); // the two successful claims above
  });

  it('caps the unclaimed pool per device', async () => {
    const batch = Array.from({ length: 100 }, (_, i) => `ZGF2ZS0${i}`);
    await dir.publish(daveAuth, 'REFWRQ==', batch); // 100 available
    await dir.publish(daveAuth, 'REFWRQ==', batch); // 200 — at the cap
    await expect(dir.publish(daveAuth, 'REFWRQ==', ['one-more'])).rejects.toThrow(); // 201 > 200
  });
});
