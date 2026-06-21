import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  generateSignatureKeypair,
  signEnrollApproval,
  signWithdraw,
} from '@argus/crypto/device-proof';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { getDb } from '../db/index.js';
import { InProcessRealtimeBus } from '../realtime/in-process-realtime-bus.js';
import { DevicesService } from './devices.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
// Bus is a real in-process bus we spy on; AuditService is faked so we can assert the recorded event.
const DB_URL = process.env.DATABASE_URL;

class FakeAudit extends AuditService {
  override record = vi.fn((): Promise<void> => Promise.resolve());
}

function proof(sig: Uint8Array): string {
  return Buffer.from(sig).toString('base64url');
}

describe.skipIf(!DB_URL)('DevicesService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  const bus = new InProcessRealtimeBus();
  const audit = new FakeAudit();
  const svc = new DevicesService(bus, audit);

  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let aliceSub: string;
  let d1Id: string; // alice's trusted (non-provisional) approver device
  let d1Priv: Uint8Array;
  let bobDeviceId: string; // tenant B device — ownership-isolation target

  const auth = (): VerifiedAuth => ({ sub: aliceSub, tenantId: tenantA });

  // Fresh device owned by alice, with a real Ed25519 keypair (signature_public_key = base64(pub)).
  async function freshDevice(provisional: boolean) {
    const kp = generateSignatureKeypair();
    const spk = Buffer.from(kp.publicKey).toString('base64');
    const [device] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key, is_provisional)
      values (${tenantA}, ${aliceId}, ${spk}, ${provisional})
      returning id`;
    return { id: device!.id as string, priv: kp.privateKey, spk };
  }

  async function freshEnrollment(
    requestingDeviceId: string,
    opts: { status?: string; expired?: boolean } = {},
  ) {
    const status = opts.status ?? 'pending';
    const expiresAt = new Date(Date.now() + (opts.expired ? -60_000 : 15 * 60_000)).toISOString();
    const [enrollment] = await sql`
      insert into device_enrollments (tenant_id, user_id, requesting_device_id, fingerprint, status, expires_at)
      values (${tenantA}, ${aliceId}, ${requestingDeviceId}, 'fp', ${status}, ${expiresAt})
      returning id`;
    return enrollment!.id as string;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    const stamp = Date.now();
    aliceSub = `dev-alice-${stamp}`;

    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Dev-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Dev-B') returning id`;

    [{ id: aliceId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantA}, ${aliceSub}, 'alice@a.test', ${`Alice ${stamp}`})
      returning id`;
    const [bob] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantB}, ${`dev-bob-${stamp}`}, 'bob@b.test', ${`Bob ${stamp}`})
      returning id`;
    [{ id: bobDeviceId }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantB}, ${bob!.id}, 'PUBKEY-BOB')
      returning id`;

    const d1 = await freshDevice(false);
    d1Id = d1.id;
    d1Priv = d1.priv;
  });

  afterAll(async () => {
    if (tenantA) await sql`delete from tenants where id = ${tenantA}`;
    if (tenantB) await sql`delete from tenants where id = ${tenantB}`;
    await sql.end({ timeout: 5 });
  });

  describe('registerEnrollment', () => {
    it('inserts a pending enrollment, nudges D1 on both sub families, and audits', async () => {
      const spy = vi.spyOn(bus, 'emitDeviceEnrollmentPending');
      spy.mockClear();
      audit.record.mockClear();
      const d2 = await freshDevice(true);

      const row = await svc.registerEnrollment(auth(), d2.spk, d2.id);
      expect(row.status).toBe('pending');
      expect(row.requestingDeviceId).toBe(d2.id);
      expect(spy).toHaveBeenCalledTimes(2); // external sub + argusid:<argusId>
      expect(audit.record).toHaveBeenCalledWith(
        tenantA,
        expect.objectContaining({ eventType: 'device.enrollment_requested' }),
      );
    });

    it('rejects a device the caller does not own (BadRequest)', async () => {
      await expect(
        svc.registerEnrollment(auth(), 'PUBKEY-BOB', bobDeviceId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the fingerprint does not match the stored device key (BadRequest)', async () => {
      const d2 = await freshDevice(true);
      await expect(
        svc.registerEnrollment(auth(), 'wrong-fingerprint', d2.id),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listEnrollments', () => {
    it('returns pending non-expired enrollments and honours the status filter', async () => {
      const d2 = await freshDevice(true);
      const enrollmentId = await freshEnrollment(d2.id);

      const pending = await svc.listEnrollments(auth());
      expect(pending.map((e) => e.id)).toContain(enrollmentId);

      const approved = await svc.listEnrollments(auth(), 'approved');
      expect(approved.map((e) => e.id)).not.toContain(enrollmentId);
    });

    it('excludes expired pending enrollments', async () => {
      const d2 = await freshDevice(true);
      const expiredId = await freshEnrollment(d2.id, { expired: true });
      const pending = await svc.listEnrollments(auth());
      expect(pending.map((e) => e.id)).not.toContain(expiredId);
    });
  });

  describe('approveEnrollment', () => {
    it('approves with a valid proof, promotes D2 to non-provisional, emits and audits', async () => {
      const spy = vi.spyOn(bus, 'emitDeviceEnrollmentApproved');
      spy.mockClear();
      audit.record.mockClear();
      const d2 = await freshDevice(true);
      const enrollmentId = await freshEnrollment(d2.id);

      const row = await svc.approveEnrollment(
        auth(),
        enrollmentId,
        d1Id,
        proof(signEnrollApproval(d1Priv, d1Id, enrollmentId)),
      );
      expect(row.status).toBe('approved');
      expect(row.approvedByDeviceId).toBe(d1Id);

      const [d2row] = await sql`select is_provisional from devices where id = ${d2.id}`;
      expect(d2row!.is_provisional).toBe(false); // D2 promoted

      expect(spy).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledWith(
        tenantA,
        expect.objectContaining({ eventType: 'device.enrollment_approved' }),
      );
    });

    it('rejects self-approval with an opaque 404', async () => {
      const d2 = await freshDevice(true);
      const enrollmentId = await freshEnrollment(d2.id);
      // approvingDeviceId === requestingDeviceId → 404 before any proof check
      await expect(
        svc.approveEnrollment(
          auth(),
          enrollmentId,
          d2.id,
          proof(signEnrollApproval(d1Priv, d2.id, enrollmentId)),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a provisional approver with an opaque 404', async () => {
      const d2 = await freshDevice(true);
      const d3 = await freshDevice(true); // approver is provisional → not a valid approver
      const enrollmentId = await freshEnrollment(d2.id);
      await expect(
        svc.approveEnrollment(
          auth(),
          enrollmentId,
          d3.id,
          proof(signEnrollApproval(d3.priv, d3.id, enrollmentId)),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a bad proof with an opaque 404', async () => {
      const d2 = await freshDevice(true);
      const enrollmentId = await freshEnrollment(d2.id);
      // Sign over the WRONG enrollment id → verification fails.
      await expect(
        svc.approveEnrollment(
          auth(),
          enrollmentId,
          d1Id,
          proof(signEnrollApproval(d1Priv, d1Id, d2.id)),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rejectEnrollment', () => {
    it('marks a pending enrollment rejected and audits', async () => {
      audit.record.mockClear();
      const d2 = await freshDevice(true);
      const enrollmentId = await freshEnrollment(d2.id);

      await svc.rejectEnrollment(auth(), enrollmentId);
      const [row] = await sql`select status from device_enrollments where id = ${enrollmentId}`;
      expect(row!.status).toBe('rejected');
      expect(audit.record).toHaveBeenCalledWith(
        tenantA,
        expect.objectContaining({ eventType: 'device.enrollment_rejected' }),
      );
    });

    it('throws NotFoundException for an unknown enrollment', async () => {
      await expect(
        svc.rejectEnrollment(auth(), '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('withdrawDevice', () => {
    it('deletes the device (and its pending welcomes) with a valid proof', async () => {
      const dw = await freshDevice(false);
      // A welcome sealed to this device — withdraw must clear it first (FK is ON DELETE NO ACTION).
      const [conv] = await sql`
        insert into conversations (tenant_id, created_by) values (${tenantA}, ${aliceId}) returning id`;
      const convId = conv!.id as string;
      await sql`insert into conversation_members (tenant_id, conversation_id, user_id)
                values (${tenantA}, ${convId}, ${aliceId})`;
      const [welcomeRow] = await sql`
        insert into conversation_welcomes
          (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
        values (${tenantA}, ${convId}, ${aliceId}, ${dw.id}, ${aliceId}, 'w-ct', 'rt-ct')
        returning id`;
      const welcomeId = welcomeRow!.id as string;

      await svc.withdrawDevice(auth(), dw.spk, proof(signWithdraw(dw.priv, dw.spk)));

      const [device] = await sql`select id from devices where id = ${dw.id}`;
      expect(device).toBeUndefined();
      const [welcome] = await sql`select id from conversation_welcomes where id = ${welcomeId}`;
      expect(welcome).toBeUndefined();
    });

    it('is idempotent when the device no longer exists (no throw)', async () => {
      await expect(
        svc.withdrawDevice(
          auth(),
          'PUBKEY-NEVER-EXISTED',
          proof(signWithdraw(d1Priv, 'PUBKEY-NEVER-EXISTED')),
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects an invalid proof with BadRequest (device untouched)', async () => {
      const dw = await freshDevice(false);
      await expect(
        svc.withdrawDevice(auth(), dw.spk, proof(signWithdraw(d1Priv, dw.spk))), // signed with the wrong key
      ).rejects.toBeInstanceOf(BadRequestException);
      const [device] = await sql`select id from devices where id = ${dw.id}`;
      expect(device).toBeDefined();
    });
  });

  describe('migrateDevice', () => {
    it('re-registers the same key as non-provisional with a valid proof', async () => {
      const dm = await freshDevice(true);
      await svc.migrateDevice(auth(), dm.spk, proof(signWithdraw(dm.priv, dm.spk)));
      const [row] =
        await sql`select is_provisional from devices where signature_public_key = ${dm.spk}`;
      expect(row).toBeDefined();
      expect(row!.is_provisional).toBe(false);
    });

    it('is idempotent when the key is not present (no throw)', async () => {
      await expect(
        svc.migrateDevice(
          auth(),
          'PUBKEY-NEVER-EXISTED-2',
          proof(signWithdraw(d1Priv, 'PUBKEY-NEVER-EXISTED-2')),
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects an invalid proof with BadRequest', async () => {
      const dm = await freshDevice(true);
      await expect(
        svc.migrateDevice(auth(), dm.spk, proof(signWithdraw(d1Priv, dm.spk))), // wrong key
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listMyConversations', () => {
    it('returns metadata only for conversations the caller belongs to', async () => {
      const [conv] = await sql`
        insert into conversations (tenant_id, created_by, is_direct)
        values (${tenantA}, ${aliceId}, true) returning id`;
      const convId = conv!.id as string;
      await sql`insert into conversation_members (tenant_id, conversation_id, user_id)
                values (${tenantA}, ${convId}, ${aliceId})`;

      const rows = await svc.listMyConversations(auth());
      const mine = rows.find((r) => r.conversationId === convId);
      expect(mine).toBeDefined();
      expect(mine!.isDirect).toBe(true);
      // Metadata only — no content fields on the shape.
      expect(Object.keys(mine!).sort()).toEqual(['conversationId', 'createdAt', 'isDirect']);
    });
  });
});
