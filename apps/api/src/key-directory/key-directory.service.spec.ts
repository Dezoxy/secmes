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
  let frankId: string;
  const dir = new KeyDirectoryService(new AuditService());

  let aliceAuth: VerifiedAuth;
  let bobAuth: VerifiedAuth;
  let carolAuth: VerifiedAuth;
  let daveAuth: VerifiedAuth;
  let eveAuth: VerifiedAuth;
  let frankAuth: VerifiedAuth;

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('KD-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('KD-B') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-alice', 'al@a.test')`;
    [{ id: bobId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-bob', 'bob@a.test') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'kd-carol', 'c@b.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-dave', 'dave@a.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-eve', 'eve@a.test')`;
    [{ id: frankId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kd-frank', 'frank@a.test') returning id`;

    aliceAuth = { sub: 'kd-alice', tenantId: tenantA };
    bobAuth = { sub: 'kd-bob', tenantId: tenantA };
    carolAuth = { sub: 'kd-carol', tenantId: tenantB };
    daveAuth = { sub: 'kd-dave', tenantId: tenantA };
    eveAuth = { sub: 'kd-eve', tenantId: tenantA };
    frankAuth = { sub: 'kd-frank', tenantId: tenantA };
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
    expect(res.available).toBe(2); // both unclaimed after publish
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

  it('dedupes KeyPackages within a batch and across retries', async () => {
    const r1 = await dir.publish(eveAuth, 'RVZF', ['e1', 'e1', 'e2']); // 'e1' duplicated in-batch
    expect(r1.published).toBe(2); // e1, e2
    expect(r1.available).toBe(2);
    const r2 = await dir.publish(eveAuth, 'RVZF', ['e2', 'e3']); // 'e2' already published
    expect(r2.published).toBe(1); // only e3 is new
    expect(r2.available).toBe(3); // e1, e2, e3 unclaimed
  });

  it('caps the unclaimed pool per device', async () => {
    const batchA = Array.from({ length: 100 }, (_, i) => `dave-a-${i}`);
    const batchB = Array.from({ length: 100 }, (_, i) => `dave-b-${i}`); // distinct from A
    await dir.publish(daveAuth, 'REFWRQ==', batchA); // 100 available
    await dir.publish(daveAuth, 'REFWRQ==', batchB); // 200 — at the cap
    await expect(dir.publish(daveAuth, 'REFWRQ==', ['dave-extra'])).rejects.toThrow(); // 201 > 200

    // At the cap, re-publishing an EXISTING batch inserts 0 → must NOT be rejected (idempotent).
    const retry = await dir.publish(daveAuth, 'REFWRQ==', batchA);
    expect(retry.published).toBe(0);
    expect(retry.available).toBe(200); // still 200 unclaimed (republish inserted nothing)
  });

  // Count Frank's device packages (owner connection, bypasses RLS — assertion helper, not the SUT path).
  const countPackages = async (sig: string, claimed: boolean): Promise<number> => {
    const [r] = await sql`select count(*)::int as n from key_packages kp
                          join devices d on d.id = kp.device_id
                          where d.user_id = ${frankId} and d.signature_public_key = ${sig}
                            and kp.claimed_at is ${claimed ? sql`not null` : sql`null`}`;
    return (r as { n: number }).n;
  };

  it('revoke: deletes only the caller’s own UNCLAIMED packages; claimed ones survive', async () => {
    const sig = 'RlJBTksx'; // Frank device 1
    await dir.publish(frankAuth, sig, ['f1', 'f2', 'f3']); // 3 unclaimed
    await dir.claim(aliceAuth, frankId); // Alice claims one → 1 claimed, 2 unclaimed
    const res = await dir.revokeUnclaimed(frankAuth, sig);
    expect(res.revoked).toBe(2); // the two UNCLAIMED were deleted
    expect(await countPackages(sig, false)).toBe(0); // no unclaimed left
    expect(await countPackages(sig, true)).toBe(1); // the claimed one survives (in-flight Welcome)
  });

  it('revoke: is idempotent — revoking again returns 0', async () => {
    const sig = 'RlJBTksy';
    await dir.publish(frankAuth, sig, ['g1', 'g2']);
    expect((await dir.revokeUnclaimed(frankAuth, sig)).revoked).toBe(2);
    expect((await dir.revokeUnclaimed(frankAuth, sig)).revoked).toBe(0); // nothing left
  });

  it('revoke: cannot touch another user’s device packages (ownership authz)', async () => {
    const sig = 'RlJBTksz';
    await dir.publish(frankAuth, sig, ['h1', 'h2']); // Frank's device + packages
    // Eve (same tenant) tries to revoke using Frank's device sig key → no device for Eve+sig → 0.
    expect((await dir.revokeUnclaimed(eveAuth, sig)).revoked).toBe(0);
    expect(await countPackages(sig, false)).toBe(2); // Frank's packages intact
  });

  it('revoke: cannot cross tenants (RLS hides the device)', async () => {
    const sig = 'RlJBTksw';
    await dir.publish(frankAuth, sig, ['i1', 'i2']); // tenant-A device
    expect((await dir.revokeUnclaimed(carolAuth, sig)).revoked).toBe(0); // Carol is tenant B
    expect(await countPackages(sig, false)).toBe(2); // intact
  });

  it('revoke: audits an EFFECTIVE revoke, not a no-op', async () => {
    const sig = 'RlJBTksp';
    await dir.publish(frankAuth, sig, ['j1']);
    const auditCount = async (): Promise<number> => {
      const [r] = await sql`select count(*)::int as n from audit_events
                            where tenant_id = ${tenantA} and event_type = 'keydir.key_packages_revoked'`;
      return (r as { n: number }).n;
    };
    const before = await auditCount();
    await dir.revokeUnclaimed(frankAuth, sig); // revokes 1 → audited
    const afterEffective = await auditCount();
    await dir.revokeUnclaimed(frankAuth, sig); // 0 → NOT audited
    const afterNoop = await auditCount();
    expect(afterEffective - before).toBe(1); // the effective revoke added exactly one event
    expect(afterNoop - afterEffective).toBe(0); // the no-op added none
  });
});
