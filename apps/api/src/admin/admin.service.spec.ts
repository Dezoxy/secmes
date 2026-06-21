import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { getDb } from '../db/index.js';
import { AdminService } from './admin.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
// AuditService is faked (a spy) so we assert revokeDevice records the right event without writing rows.
const DB_URL = process.env.DATABASE_URL;

class FakeAudit extends AuditService {
  override record = vi.fn((): Promise<void> => Promise.resolve());
}

describe.skipIf(!DB_URL)('AdminService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  const audit = new FakeAudit();
  const svc = new AdminService(audit);

  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let aliceSub: string;
  let aliceDevice1: string; // listDevices / prefix assertion
  let aliceDevice2: string; // revoke target
  let suspendedDevice: string; // owner inactive → excluded from listDevices
  let bobDevice: string; // tenant B → cross-tenant revoke target
  let evtOldId: string;
  let evtMidId: string;
  let evtNewId: string;

  const auth = (): VerifiedAuth => ({ sub: aliceSub, tenantId: tenantA });

  beforeAll(async () => {
    sql = getDb().sql;
    const stamp = Date.now();
    aliceSub = `admin-alice-${stamp}`;

    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Admin-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Admin-B') returning id`;

    [{ id: aliceId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantA}, ${aliceSub}, 'alice@a.test', ${`Alice ${stamp}`})
      returning id`;
    const [suspendedUser] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name, status)
      values (${tenantA}, ${`admin-susp-${stamp}`}, 'susp@a.test', ${`Susp ${stamp}`}, 'suspended')
      returning id`;
    const suspendedId = suspendedUser!.id as string;
    const [bobUser] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantB}, ${`admin-bob-${stamp}`}, 'bob@b.test', ${`Bob ${stamp}`})
      returning id`;
    const bobId = bobUser!.id as string;

    [{ id: aliceDevice1 }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantA}, ${aliceId}, 'PUBKEY-ALICE-0123456789ABCDEF')
      returning id`;
    [{ id: aliceDevice2 }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantA}, ${aliceId}, 'PUBKEY-ALICE-SECOND-DEVICE')
      returning id`;
    [{ id: suspendedDevice }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantA}, ${suspendedId}, 'PUBKEY-SUSPENDED-USER')
      returning id`;
    [{ id: bobDevice }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantB}, ${bobId}, 'PUBKEY-BOB-DEVICE')
      returning id`;

    // Three audit rows for alice (actor_sub = her external_identity_id so the display-name join resolves),
    // with explicit spaced timestamps so the created_at-desc ordering / cursor pagination is deterministic.
    [{ id: evtOldId }] = await sql`
      insert into audit_events (tenant_id, actor_sub, event_type, created_at)
      values (${tenantA}, ${aliceSub}, 'device.registered', '2026-01-01T00:00:00Z') returning id`;
    [{ id: evtMidId }] = await sql`
      insert into audit_events (tenant_id, actor_sub, event_type, created_at)
      values (${tenantA}, ${aliceSub}, 'device.revoked', '2026-01-02T00:00:00Z') returning id`;
    [{ id: evtNewId }] = await sql`
      insert into audit_events (tenant_id, actor_sub, event_type, created_at)
      values (${tenantA}, ${aliceSub}, 'session.created', '2026-01-03T00:00:00Z') returning id`;
  });

  afterAll(async () => {
    if (tenantA) await sql`delete from tenants where id = ${tenantA}`;
    if (tenantB) await sql`delete from tenants where id = ${tenantB}`;
    await sql.end({ timeout: 5 });
  });

  describe('listDevices', () => {
    it('lists devices of active users only, with a 12-char key prefix', async () => {
      const rows = await svc.listDevices(auth());
      const ids = rows.map((r) => r.deviceId);
      expect(ids).toContain(aliceDevice1);
      expect(ids).toContain(aliceDevice2);
      expect(ids).not.toContain(suspendedDevice); // owner is suspended → excluded by the active join
      expect(ids).not.toContain(bobDevice); // other tenant → RLS-scoped out

      const d1 = rows.find((r) => r.deviceId === aliceDevice1)!;
      expect(d1.signaturePublicKeyPrefix).toBe('PUBKEY-ALICE'); // left(key, 12)
      expect(d1.signaturePublicKeyPrefix).toHaveLength(12);
      expect(d1.displayName).toContain('Alice');
    });
  });

  describe('revokeDevice', () => {
    it('deletes the device and records a device.revoked audit event', async () => {
      audit.record.mockClear();
      await svc.revokeDevice(auth(), aliceDevice2);

      const [gone] = await sql`select id from devices where id = ${aliceDevice2}`;
      expect(gone).toBeUndefined();
      expect(audit.record).toHaveBeenCalledWith(
        tenantA,
        expect.objectContaining({ eventType: 'device.revoked', actorSub: aliceSub }),
      );
    });

    it('throws NotFoundException for an unknown device', async () => {
      await expect(
        svc.revokeDevice(auth(), '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-tenant: cannot revoke a device in another tenant (NotFound, no audit)', async () => {
      audit.record.mockClear();
      await expect(svc.revokeDevice(auth(), bobDevice)).rejects.toBeInstanceOf(NotFoundException);
      const [stillThere] = await sql`select id from devices where id = ${bobDevice}`;
      expect(stillThere).toBeDefined();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('listAudit', () => {
    it('returns newest-first events with the actor display name resolved', async () => {
      const page = await svc.listAudit(auth(), 100);
      const ours = page.events.filter((e) => [evtOldId, evtMidId, evtNewId].includes(e.id));
      expect(ours.map((e) => e.id)).toEqual([evtNewId, evtMidId, evtOldId]); // created_at desc
      expect(ours[0]!.actorDisplayName).toContain('Alice');
      expect(ours[0]!.actorSub).toBe(aliceSub);
    });

    it('paginates via an opaque cursor', async () => {
      const first = await svc.listAudit(auth(), 2);
      expect(first.events).toHaveLength(2);
      expect(first.events.map((e) => e.id)).toEqual([evtNewId, evtMidId]);
      expect(first.nextCursor).toBeTruthy();

      const second = await svc.listAudit(auth(), 2, first.nextCursor);
      expect(second.events.map((e) => e.id)).toContain(evtOldId);
    });

    it('clamps a limit below 1 up to a floor of 1', async () => {
      const page = await svc.listAudit(auth(), 0);
      expect(page.events).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy(); // more remain → cursor emitted
    });

    it('rejects a malformed cursor with BadRequestException', async () => {
      await expect(svc.listAudit(auth(), 10, 'not-a-valid-cursor')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
