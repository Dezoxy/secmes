import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireUser } from '../messaging/membership.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { verifyEnrollApproval } from '@argus/crypto/device-proof';
import { AuditService } from '../audit/audit.service.js';

export interface EnrollmentRow {
  id: string;
  requestingDeviceId: string;
  approvedByDeviceId: string | null;
  fingerprint: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly audit: AuditService,
  ) {}

  /**
   * D2 registers a pending enrollment request. Verifies device ownership (the deviceId must belong
   * to the authenticated user in this tenant) then inserts a device_enrollments row and nudges D1.
   * Rate-limited to bound DoS T4 from the threat model.
   */
  async registerEnrollment(
    auth: VerifiedAuth,
    fingerprint: string,
    deviceId: string,
  ): Promise<EnrollmentRow> {
    const row = await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth.sub);

      // Verify the requesting device belongs to this user (ownership authz — RLS + user_id check).
      const [device] = await tx
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, userId)))
        .limit(1);
      if (!device) throw new BadRequestException('device not found or not owned by this user');

      const [enrollment] = await tx
        .insert(schema.deviceEnrollments)
        .values({
          tenantId: auth.tenantId,
          userId,
          requestingDeviceId: device.id,
          fingerprint,
          status: 'pending',
          // expiresAt default: 15 minutes from now (set by DB default, but make it explicit)
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        })
        .returning();
      if (!enrollment) throw new Error('enrollment insert returned no row');
      return enrollment;
    });

    // Nudge D1 out-of-band (WS); if the bus is down, D1 sees the pending enrollment on next poll.
    this.bus.emitDeviceEnrollmentPending({
      tenantId: auth.tenantId,
      enrollmentId: row.id,
      userSub: auth.sub,
    });

    await this.audit.record(auth.tenantId, {
      eventType: 'device.enrollment_requested',
      actorSub: auth.sub,
    });

    return row;
  }

  /**
   * List pending (non-expired) enrollments for the authenticated user. Used by D1 to poll for
   * new linking requests. Returns metadata only — never key material.
   */
  async listEnrollments(auth: VerifiedAuth, status?: string): Promise<EnrollmentRow[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth.sub);
      const effectiveStatus = status ?? 'pending';
      return tx
        .select()
        .from(schema.deviceEnrollments)
        .where(
          and(
            eq(schema.deviceEnrollments.userId, userId),
            eq(schema.deviceEnrollments.status, effectiveStatus),
            // Expiry filter only applies to pending rows; approved/rejected rows are terminal
            // and must remain visible indefinitely (e.g. claimEnrolledOwnDevices checks 'approved').
            effectiveStatus === 'pending'
              ? gt(schema.deviceEnrollments.expiresAt, sql`now()`)
              : undefined,
          ),
        )
        .orderBy(schema.deviceEnrollments.createdAt);
    });
  }

  /**
   * D1 approves D2's enrollment. Verifies D1's enroll-proof (proof-of-possession), updates the
   * enrollment row, and nudges D2 to drain its Welcomes. The server makes NO trust decision —
   * the proof is the cryptographic evidence that D1 approved.
   */
  async approveEnrollment(
    auth: VerifiedAuth,
    enrollmentId: string,
    approvingDeviceId: string,
    proofBase64url: string,
  ): Promise<EnrollmentRow> {
    const row = await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth.sub);

      // Load the pending enrollment (user-scoped by RLS + where clause).
      const [enrollment] = await tx
        .select()
        .from(schema.deviceEnrollments)
        .where(
          and(
            eq(schema.deviceEnrollments.id, enrollmentId),
            eq(schema.deviceEnrollments.userId, userId),
            eq(schema.deviceEnrollments.status, 'pending'),
            gt(schema.deviceEnrollments.expiresAt, sql`now()`),
          ),
        )
        .limit(1);
      // Opaque 404 — never reveal which enrollments exist to a caller who can't prove ownership.
      if (!enrollment) throw new NotFoundException('enrollment not found');

      // A device cannot approve its own enrollment — that would bypass the verified-linking property
      // entirely (D2 holds its own Ed25519 key and can trivially forge a valid enroll-proof for itself).
      if (enrollment.requestingDeviceId === approvingDeviceId) {
        throw new NotFoundException('enrollment not found');
      }

      // Load D1's signature public key (must belong to the same user).
      const [d1Device] = await tx
        .select({ signaturePublicKey: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(and(eq(schema.devices.id, approvingDeviceId), eq(schema.devices.userId, userId)))
        .limit(1);
      if (!d1Device) throw new NotFoundException('enrollment not found');

      // Verify Ed25519 enroll-proof: argus-enroll:v1\n${approvingDeviceId}\n${enrollmentId}.
      // verifyEnrollApproval is total (never throws). A bad proof → same opaque 404.
      const proven = verifyEnrollApproval(
        Buffer.from(d1Device.signaturePublicKey, 'base64'),
        approvingDeviceId,
        enrollmentId,
        Buffer.from(proofBase64url, 'base64url'),
      );
      if (!proven) throw new NotFoundException('enrollment not found');

      // Add status = 'pending' to the WHERE so a concurrent approve on the same row gets 0 rows
      // and throws NotFoundException instead of double-emitting audit + WS events.
      const [updated] = await tx
        .update(schema.deviceEnrollments)
        .set({
          status: 'approved',
          approvedByDeviceId: approvingDeviceId,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(schema.deviceEnrollments.id, enrollmentId),
            eq(schema.deviceEnrollments.status, 'pending'),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundException('enrollment not found');
      return updated;
    });

    this.bus.emitDeviceEnrollmentApproved({
      tenantId: auth.tenantId,
      enrollmentId: row.id,
      userSub: auth.sub,
    });

    await this.audit.record(auth.tenantId, {
      eventType: 'device.enrollment_approved',
      actorSub: auth.sub,
    });

    return row;
  }

  /**
   * D1 rejects D2's enrollment. Idempotent metadata update; no proof required — rejection is
   * non-escalating (a rejected D2 can re-register after its enrollment expires).
   */
  async rejectEnrollment(auth: VerifiedAuth, enrollmentId: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth.sub);

      const [updated] = await tx
        .update(schema.deviceEnrollments)
        .set({ status: 'rejected', resolvedAt: new Date() })
        .where(
          and(
            eq(schema.deviceEnrollments.id, enrollmentId),
            eq(schema.deviceEnrollments.userId, userId),
            eq(schema.deviceEnrollments.status, 'pending'),
          ),
        )
        .returning({ id: schema.deviceEnrollments.id });
      if (!updated) throw new NotFoundException('enrollment not found');
    });

    await this.audit.record(auth.tenantId, {
      eventType: 'device.enrollment_rejected',
      actorSub: auth.sub,
    });
  }

  /**
   * Return the caller's conversation IDs. Used by D1 after approving D2 to compute the fan-out
   * diff — which conversations D1 must issue add-commits for. METADATA ONLY: IDs, no content.
   */
  async listMyConversations(auth: VerifiedAuth): Promise<string[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth.sub);
      const rows = await tx
        .select({ conversationId: schema.conversationMembers.conversationId })
        .from(schema.conversationMembers)
        .where(eq(schema.conversationMembers.userId, userId));
      return rows.map((r) => r.conversationId);
    });
  }
}
