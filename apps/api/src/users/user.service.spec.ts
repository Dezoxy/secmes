import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/index.js';
import { UserService } from './user.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
// UserService has no injected deps; every method runs inside withTenant() so the DB is exercised
// directly (the "no DB" wording in the track doc was corrected — the dominant pattern here is live-DB).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('UserService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  const svc = new UserService();

  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let aliceSub: string;
  let aliceArgusId: string;
  let suspendedSub: string;
  let suspendedArgusId: string;
  let bobSub: string; // tenant B — cross-tenant isolation target
  let bobArgusId: string;

  beforeAll(async () => {
    sql = getDb().sql;
    const stamp = Date.now();
    aliceSub = `user-alice-${stamp}`;
    suspendedSub = `user-susp-${stamp}`;
    bobSub = `user-bob-${stamp}`;

    [{ id: tenantA }] = await sql`insert into tenants (name) values ('User-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('User-B') returning id`;

    [{ id: aliceId, argus_id: aliceArgusId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name, avatar_seed)
      values (${tenantA}, ${aliceSub}, 'alice@a.test', ${`Alice ${stamp}`}, 'seed-alice')
      returning id, argus_id`;
    [{ argus_id: suspendedArgusId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name, status)
      values (${tenantA}, ${suspendedSub}, 'susp@a.test', ${`Susp ${stamp}`}, 'suspended')
      returning argus_id`;
    [{ argus_id: bobArgusId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantB}, ${bobSub}, 'bob@b.test', ${`Bob ${stamp}`})
      returning argus_id`;
  });

  afterAll(async () => {
    if (tenantA) await sql`delete from tenants where id = ${tenantA}`;
    if (tenantB) await sql`delete from tenants where id = ${tenantB}`;
    await sql.end({ timeout: 5 });
  });

  describe('getByAuth', () => {
    it('returns the mapped record for an active user resolved by sub', async () => {
      const rec = await svc.getByAuth({ sub: aliceSub, tenantId: tenantA });
      expect(rec).toEqual({
        id: aliceId,
        argusId: aliceArgusId,
        displayName: expect.stringContaining('Alice'),
        avatarSeed: 'seed-alice',
        role: 'member',
      });
    });

    it('resolves by userId (PK) when the uid claim is present', async () => {
      // A bogus sub proves resolution went through userId, not external_identity_id.
      const rec = await svc.getByAuth({
        sub: 'does-not-match',
        tenantId: tenantA,
        userId: aliceId,
      });
      expect(rec?.id).toBe(aliceId);
    });

    it('returns undefined for a suspended (inactive) user', async () => {
      const rec = await svc.getByAuth({ sub: suspendedSub, tenantId: tenantA });
      expect(rec).toBeUndefined();
    });

    it('returns undefined when the identity is not provisioned in the tenant', async () => {
      const rec = await svc.getByAuth({ sub: 'nobody-here', tenantId: tenantA });
      expect(rec).toBeUndefined();
    });

    it('cross-tenant: bob (tenant B) is invisible from tenant A even with his sub', async () => {
      const rec = await svc.getByAuth({ sub: bobSub, tenantId: tenantA });
      expect(rec).toBeUndefined();
    });
  });

  describe('lookupByArgusId', () => {
    it('returns the public projection for an active argus-id match', async () => {
      const res = await svc.lookupByArgusId(tenantA, aliceArgusId);
      expect(res).toEqual({
        userId: aliceId,
        argusId: aliceArgusId,
        displayName: expect.stringContaining('Alice'),
        avatarSeed: 'seed-alice',
      });
    });

    it('returns null for an unknown argus-id', async () => {
      const res = await svc.lookupByArgusId(tenantA, 'ARGUS-DOES-NOT-EXIST');
      expect(res).toBeNull();
    });

    it('returns null for a suspended user (no oracle for inactive accounts)', async () => {
      const res = await svc.lookupByArgusId(tenantA, suspendedArgusId);
      expect(res).toBeNull();
    });

    it('cross-tenant: bob argus-id does not resolve from tenant A', async () => {
      const res = await svc.lookupByArgusId(tenantA, bobArgusId);
      expect(res).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('updates only the provided fields', async () => {
      await svc.updateProfile(
        { tenantId: tenantA, userId: aliceId },
        { displayName: `Alice Renamed ${Date.now()}` },
      );
      const [row] = await sql`select display_name, avatar_seed from users where id = ${aliceId}`;
      expect(row!.display_name).toContain('Alice Renamed');
      expect(row!.avatar_seed).toBe('seed-alice'); // untouched

      await svc.updateProfile({ tenantId: tenantA, userId: aliceId }, { avatarSeed: 'seed-2' });
      const [row2] = await sql`select avatar_seed from users where id = ${aliceId}`;
      expect(row2!.avatar_seed).toBe('seed-2');
    });

    it('is a no-op (no throw) when neither field is provided', async () => {
      await expect(
        svc.updateProfile({ tenantId: tenantA, userId: aliceId }, {}),
      ).resolves.toBeUndefined();
    });

    it('throws NotFoundException when the user row is absent', async () => {
      await expect(
        svc.updateProfile(
          { tenantId: tenantA, userId: '00000000-0000-0000-0000-000000000000' },
          { displayName: 'ghost' },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
