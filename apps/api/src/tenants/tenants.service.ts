import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';

import { AuditService } from '../audit/audit.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface CreateInviteResult {
  inviteId: string;
  /** Plaintext token — returned once, never stored. */
  token: string;
  expiresAt: string;
}

@Injectable()
export class TenantsService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Create an invite token (admin-minted registration code) for the caller's tenant. Returns the
   * plaintext token once — never stored. The code is the membership gate: it is redeemed by the
   * passkey registration flow (auth/webauthn redeemCode), single-use and delete-on-use.
   */
  async createInvite(auth: VerifiedAuth): Promise<CreateInviteResult> {
    const raw = randomBytes(32).toString('base64url');
    const tokenHash = sha256hex(raw);

    const [invite] = await withTenant(auth.tenantId, async (tx) => {
      // Find the admin user's row id (needed for created_by FK).
      const [me] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, auth.tenantId),
            auth.userId
              ? eq(schema.users.id, auth.userId)
              : eq(schema.users.externalIdentityId, auth.sub),
          ),
        )
        .limit(1);
      if (!me) throw new NotFoundException('caller user row not found');

      return tx
        .insert(schema.tenantInvites)
        .values({
          tenantId: auth.tenantId,
          createdBy: me.id,
          tokenHash,
        })
        .returning({
          id: schema.tenantInvites.id,
          expiresAt: schema.tenantInvites.expiresAt,
        });
    });
    if (!invite) throw new Error('invite insert returned no row');

    return {
      inviteId: invite.id,
      token: raw,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** List active (not accepted, not revoked, not expired) invites for the caller's tenant. */
  async listInvites(auth: VerifiedAuth) {
    return withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.tenantInvites.id,
          expiresAt: schema.tenantInvites.expiresAt,
          acceptedAt: schema.tenantInvites.acceptedAt,
          revokedAt: schema.tenantInvites.revokedAt,
          createdAt: schema.tenantInvites.createdAt,
        })
        .from(schema.tenantInvites)
        .where(
          and(
            eq(schema.tenantInvites.tenantId, auth.tenantId),
            isNull(schema.tenantInvites.acceptedAt),
            isNull(schema.tenantInvites.revokedAt),
            sql`${schema.tenantInvites.expiresAt} > now()`,
          ),
        )
        .orderBy(sql`${schema.tenantInvites.createdAt} desc`),
    );
  }

  /** Revoke an invite (admin). 404 if not found or already accepted/revoked. */
  async revokeInvite(auth: VerifiedAuth, inviteId: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .update(schema.tenantInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.tenantInvites.id, inviteId),
            eq(schema.tenantInvites.tenantId, auth.tenantId),
            isNull(schema.tenantInvites.revokedAt),
            isNull(schema.tenantInvites.acceptedAt),
          ),
        )
        .returning({ id: schema.tenantInvites.id });
      if (!row) throw new NotFoundException('invite not found or already used/revoked');
    });
  }

  /** List active members of the caller's tenant. */
  async listMembers(auth: VerifiedAuth) {
    return withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          userId: schema.users.id,
          displayName: schema.users.displayName,
          role: schema.users.role,
        })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.status, 'active'),
            or(isNull(schema.users.displayName), ne(schema.users.displayName, 'breakglass-admin')),
          ),
        )
        .orderBy(schema.users.createdAt),
    );
  }

  /** Change a member's role (admin only). Prevents demoting the last admin. */
  async setMemberRole(
    auth: VerifiedAuth,
    targetUserId: string,
    newRole: 'admin' | 'member',
  ): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      // The breakglass-admin user is the last-resort recovery path — it must not be
      // demotable or revocable via regular member lifecycle actions.
      const [tgt] = await tx
        .select({ displayName: schema.users.displayName })
        .from(schema.users)
        .where(and(eq(schema.users.id, targetUserId), eq(schema.users.tenantId, auth.tenantId)))
        .limit(1);
      if (tgt?.displayName === 'breakglass-admin') {
        throw new ForbiddenException('cannot modify the breakglass-admin account');
      }

      // Prevent leaving the tenant with zero admins.
      if (newRole === 'member') {
        // Lock admin rows before counting to prevent concurrent demotions leaving zero admins.
        await tx.execute(
          sql`SELECT id FROM users WHERE tenant_id = ${auth.tenantId} AND role = 'admin' AND status = 'active' FOR UPDATE`, // nosemgrep: argus-no-sql-string-interpolation
        );
        const admins = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.tenantId, auth.tenantId),
              eq(schema.users.role, 'admin'),
              eq(schema.users.status, 'active'),
              or(
                isNull(schema.users.displayName),
                ne(schema.users.displayName, 'breakglass-admin'),
              ),
            ),
          );
        // Only one admin and it's the target → demoting would leave zero admins.
        if (admins.length === 1 && admins[0]?.id === targetUserId) {
          throw new ForbiddenException('cannot remove the last admin');
        }
      }

      const [updated] = await tx
        .update(schema.users)
        .set({ role: newRole })
        .where(and(eq(schema.users.id, targetUserId), eq(schema.users.tenantId, auth.tenantId)))
        .returning({ id: schema.users.id });
      if (!updated) throw new NotFoundException('user not found');
    });
    await this.audit.record(auth.tenantId, {
      eventType: 'member.role_changed',
      actorSub: auth.sub,
    });
  }

  /** Revoke a member (soft-delete, v1). Cannot revoke the last admin. */
  async revokeMember(auth: VerifiedAuth, targetUserId: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const [target] = await tx
        .select({ role: schema.users.role, displayName: schema.users.displayName })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, targetUserId),
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1);
      if (!target) throw new NotFoundException('user not found');
      if (target.displayName === 'breakglass-admin') {
        throw new ForbiddenException('cannot modify the breakglass-admin account');
      }

      if (target.role === 'admin') {
        // Lock admin rows before counting to prevent concurrent revocations leaving zero admins.
        await tx.execute(
          sql`SELECT id FROM users WHERE tenant_id = ${auth.tenantId} AND role = 'admin' AND status = 'active' FOR UPDATE`, // nosemgrep: argus-no-sql-string-interpolation
        );
        const admins = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.tenantId, auth.tenantId),
              eq(schema.users.role, 'admin'),
              eq(schema.users.status, 'active'),
              or(
                isNull(schema.users.displayName),
                ne(schema.users.displayName, 'breakglass-admin'),
              ),
            ),
          );
        if (admins.length <= 1) throw new ForbiddenException('cannot remove the last admin');
      }

      await tx
        .update(schema.users)
        .set({ status: 'revoked' })
        .where(and(eq(schema.users.id, targetUserId), eq(schema.users.tenantId, auth.tenantId)));
    });
    await this.audit.record(auth.tenantId, { eventType: 'member.revoked', actorSub: auth.sub });
  }
}
