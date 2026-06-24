import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { aliasedTable, and, eq, gt, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireUser } from '../messaging/membership.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { verifyEnrollApproval, verifyWithdraw } from '@argus/crypto/device-proof';
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
  /** D1's registered signature public key — used by D2 to verify D1's claimed key package. Present only on listEnrollments rows (JOINed); absent on register/approve/reject rows. */
  approverSignaturePublicKey?: string | null;
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
    const { row, userSubs } = await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth);

      // Verify the requesting device belongs to this user (ownership authz — RLS + user_id check).
      const [device] = await tx
        .select({ id: schema.devices.id, signaturePublicKey: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, userId)))
        .limit(1);
      if (!device) throw new BadRequestException('device not found or not owned by this user');

      // The fingerprint is the device's signature public key in base64 (used by D1 to display a 6-digit
      // code for OOB verification). Verify the client-provided value matches the server-stored key so
      // D2 cannot supply a misleading code that would cause D1 to verify against a different device.
      if (device.signaturePublicKey !== fingerprint) {
        throw new BadRequestException('fingerprint does not match device key');
      }

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

      const [userRow] = await tx
        .select({
          externalIdentityId: schema.users.externalIdentityId,
          argusId: schema.users.argusId,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const subs = userRow
        ? [userRow.externalIdentityId, `argusid:${userRow.argusId}`]
        : [auth.sub];
      return { row: enrollment, userSubs: subs };
    });

    // Nudge D1 out-of-band (WS); emit for both token families so argus and Zitadel sockets are reached.
    for (const userSub of userSubs) {
      this.bus.emitDeviceEnrollmentPending({
        tenantId: auth.tenantId,
        enrollmentId: row.id,
        userSub,
        requestingDeviceId: row.requestingDeviceId,
      });
    }

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
      const userId = await requireUser(tx, auth);
      const effectiveStatus = status ?? 'pending';
      // Join the approver's devices row so D2 can verify D1's claimed key package SPK (P1-3).
      const approverDevice = aliasedTable(schema.devices, 'approver_device');
      return tx
        .select({
          id: schema.deviceEnrollments.id,
          requestingDeviceId: schema.deviceEnrollments.requestingDeviceId,
          approvedByDeviceId: schema.deviceEnrollments.approvedByDeviceId,
          fingerprint: schema.deviceEnrollments.fingerprint,
          status: schema.deviceEnrollments.status,
          createdAt: schema.deviceEnrollments.createdAt,
          expiresAt: schema.deviceEnrollments.expiresAt,
          resolvedAt: schema.deviceEnrollments.resolvedAt,
          approverSignaturePublicKey: approverDevice.signaturePublicKey,
        })
        .from(schema.deviceEnrollments)
        .leftJoin(
          approverDevice,
          and(
            eq(approverDevice.id, schema.deviceEnrollments.approvedByDeviceId),
            eq(approverDevice.tenantId, schema.deviceEnrollments.tenantId),
          ),
        )
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
    const { row, userSubs } = await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth);

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

      // Load D1's signature public key. D1 must be non-provisional — provisional devices
      // have not themselves been verified, so allowing them to approve would let a stolen bearer
      // token publish two fresh key pairs and use one to approve the other.
      const [d1Device] = await tx
        .select({ signaturePublicKey: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.id, approvingDeviceId),
            eq(schema.devices.userId, userId),
            eq(schema.devices.isProvisional, false),
          ),
        )
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

      // Promote D2: it has now been cryptographically verified by D1's enroll-proof, so it may
      // participate in approving future enrollments from here on.
      await tx
        .update(schema.devices)
        .set({ isProvisional: false })
        .where(eq(schema.devices.id, enrollment.requestingDeviceId));

      const [userRow] = await tx
        .select({
          externalIdentityId: schema.users.externalIdentityId,
          argusId: schema.users.argusId,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const subs = userRow
        ? [userRow.externalIdentityId, `argusid:${userRow.argusId}`]
        : [auth.sub];
      return { row: updated, userSubs: subs };
    });

    for (const userSub of userSubs) {
      this.bus.emitDeviceEnrollmentApproved({
        tenantId: auth.tenantId,
        enrollmentId: row.id,
        userSub,
      });
    }

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
      const userId = await requireUser(tx, auth);

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
   * Permanently delete the caller's own device row (and its key packages via cascade). Used by the
   * legacy pre-B2 migration path: removes the old bare-userId device so the new composite-identity
   * device is published as non-provisional. Requires an Ed25519 proof-of-possession so a stolen
   * bearer token alone cannot delete trusted devices and bypass the isProvisional gate. Idempotent.
   */
  async withdrawDevice(
    auth: VerifiedAuth,
    signaturePublicKey: string,
    proofBase64url: string,
  ): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth);
      const [device] = await tx
        .select({ id: schema.devices.id, signaturePublicKey: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.userId, userId),
            eq(schema.devices.signaturePublicKey, signaturePublicKey),
          ),
        )
        .limit(1);
      if (!device) return; // idempotent — already gone

      // Proof-of-possession: caller must sign argus-withdraw:v1\n${spk} with the device private key.
      // Prevents a stolen bearer token from deleting all trusted devices and bypassing isProvisional.
      const proven = verifyWithdraw(
        Buffer.from(device.signaturePublicKey, 'base64'),
        device.signaturePublicKey,
        Buffer.from(proofBase64url, 'base64url'),
      );
      if (!proven) throw new BadRequestException('invalid withdraw proof');

      // Clear pending Welcomes for this device before deleting it. The conversation_welcomes →
      // devices FK is ON DELETE NO ACTION, so deleting the device row first would fail with a
      // FK violation if any Welcomes remain. The Welcomes are HPKE-sealed to the device's
      // private key (which we're about to destroy), so they are useless after withdrawal anyway.
      await tx
        .delete(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.tenantId, auth.tenantId),
            eq(schema.conversationWelcomes.recipientDeviceId, device.id),
          ),
        );
      await tx.delete(schema.devices).where(eq(schema.devices.id, device.id));
    });

    await this.audit.record(auth.tenantId, {
      eventType: 'device.withdrawn',
      actorSub: auth.sub,
    });
  }

  /**
   * Atomically swap the caller's device from the legacy bare-userId identity to the composite
   * userId:deviceUuid identity, without a race window. In one transaction: (1) verify proof-of-
   * possession against the current signing key, (2) delete the existing device row (and its pending
   * Welcomes, which are useless after the key is re-registered), (3) re-insert the same signing key
   * as isProvisional=false. This prevents the race that withdrawDevice + a separate publishKeyPackages
   * call leaves open: between those two calls, zero non-provisional devices exist, so a concurrent
   * POST /devices/me/key-packages with a stolen bearer token could sneak in as the new trusted device.
   */
  async migrateDevice(
    auth: VerifiedAuth,
    signaturePublicKey: string,
    proofBase64url: string,
  ): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth);

      // Look up the device FIRST — the proof must be verified against the DB-stored key, never the
      // request body. Verifying a self-attested key (from the request) before confirming the DB row
      // exists would let an attacker generate a fresh keypair, produce a valid proof for it, and
      // insert it as isProvisional=false without any existing trusted device.
      const [device] = await tx
        .select({ id: schema.devices.id, signaturePublicKey: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.userId, userId),
            eq(schema.devices.signaturePublicKey, signaturePublicKey),
          ),
        )
        .limit(1);
      if (!device) return; // idempotent — already migrated or device never provisioned under this key

      // Verify proof against the DB-stored key (mirrors withdrawDevice — the server is the oracle
      // for "this key belongs to this user", not the request body).
      const proven = verifyWithdraw(
        Buffer.from(device.signaturePublicKey, 'base64'),
        device.signaturePublicKey,
        Buffer.from(proofBase64url, 'base64url'),
      );
      if (!proven) throw new BadRequestException('invalid migrate proof');

      // Lock user row to serialize concurrent migrate/publish calls (same pattern as publish()).
      await tx.execute(sql`select 1 from users where id = ${userId} for update`);

      // Delete pending Welcomes first (FK is ON DELETE NO ACTION).
      await tx
        .delete(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.tenantId, auth.tenantId),
            eq(schema.conversationWelcomes.recipientDeviceId, device.id),
          ),
        );
      await tx.delete(schema.devices).where(eq(schema.devices.id, device.id));

      // Re-insert as non-provisional. Proof-of-possession of the DB-confirmed key is the authority
      // that this is a key-rotation / identity-rename, not a new device requiring enrollment.
      await tx
        .insert(schema.devices)
        .values({ tenantId: auth.tenantId, userId, signaturePublicKey, isProvisional: false })
        .onConflictDoNothing(); // idempotent: concurrent migrate already completed
    });

    await this.audit.record(auth.tenantId, {
      eventType: 'device.migrated',
      actorSub: auth.sub,
    });
  }

  /**
   * Return the caller's conversations with type metadata. Used by D1 for the enrollment fan-out
   * diff and by the client for roster recovery after reinstall. METADATA ONLY: no content.
   *
   * For direct (1:1) conversations, `peerUserId` carries the OTHER member's user id. It is null for
   * groups, in-flight solo conversations (peer not yet added via Welcome), and DMs whose peer row
   * was GDPR-erased. The left-join condition scopes the peer join to isDirect rows only, so group
   * conversations always return exactly one row with peerUserId = null.
   */
  async listMyConversations(auth: VerifiedAuth): Promise<
    Array<{
      conversationId: string;
      isDirect: boolean | null;
      createdAt: Date;
      peerUserId: string | null;
    }>
  > {
    return withTenant(auth.tenantId, async (tx) => {
      const userId = await requireUser(tx, auth);
      const cmPeer = aliasedTable(schema.conversationMembers, 'cm_peer');
      return (
        tx
          .select({
            conversationId: schema.conversationMembers.conversationId,
            isDirect: schema.conversations.isDirect,
            createdAt: schema.conversations.createdAt,
            peerUserId: cmPeer.userId,
          })
          .from(schema.conversationMembers)
          .innerJoin(
            schema.conversations,
            and(
              eq(schema.conversationMembers.conversationId, schema.conversations.id),
              eq(schema.conversationMembers.tenantId, schema.conversations.tenantId),
            ),
          )
          // Left-join the peer member row for DMs only. The join condition references the already-joined
          // conversations table, so groups (isDirect != true) produce no cm_peer match and return null.
          .leftJoin(
            cmPeer,
            and(
              eq(cmPeer.conversationId, schema.conversationMembers.conversationId),
              eq(cmPeer.tenantId, schema.conversationMembers.tenantId),
              sql`${cmPeer.userId} != ${userId}::uuid`,
              eq(schema.conversations.isDirect, true),
            ),
          )
          .where(eq(schema.conversationMembers.userId, userId))
      );
    });
  }
}
