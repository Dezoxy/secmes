import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import type { MaybeUnboundAuth, VerifiedAuth } from '../auth/auth.service.js';
import { schema, withRouting, withTenant } from '../db/index.js';
import { generateHandle } from '../users/handle-words.js';

const MAX_HANDLE_ATTEMPTS = 8;
const HANDLE_UNIQUE_INDEX = 'users_tenant_display_name_idx';

function isHandleCollision(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur !== 'object') break;
    const o = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (o.code === '23505') {
      const c =
        (typeof o.constraint_name === 'string' && o.constraint_name) ||
        (typeof o.constraint === 'string' && o.constraint) ||
        '';
      if (c === HANDLE_UNIQUE_INDEX) return true;
    }
    cur = o.cause;
  }
  return false;
}

function isSubCollision(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur !== 'object') break;
    const o = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (o.code === '23505') {
      const c =
        (typeof o.constraint_name === 'string' && o.constraint_name) ||
        (typeof o.constraint === 'string' && o.constraint) ||
        '';
      if (c === 'user_tenant_index_pkey') return true;
    }
    cur = o.cause;
  }
  return false;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface CreateTenantResult {
  tenantId: string;
  userId: string;
}

export interface CreateInviteResult {
  inviteId: string;
  /** Plaintext token — returned once, never stored. */
  token: string;
  expiresAt: string;
}

export interface AcceptInviteResult {
  tenantId: string;
  userId: string;
}

@Injectable()
export class TenantsService {
  /**
   * Create a new tenant and its first admin user atomically.
   * Three rows are inserted: `tenants`, `users` (role: admin), `user_tenant_index`.
   * Throws 409 if the user is already bound (sub PK conflict).
   */
  async createTenant(
    auth: MaybeUnboundAuth,
    name: string,
    generate: () => string = generateHandle,
  ): Promise<CreateTenantResult> {
    const { sub, email } = auth;
    if (auth.tenantId) throw new ConflictException('already bound to a tenant');
    if (!email)
      throw new BadRequestException('token is missing the email claim required to provision');

    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
      const tenantId = randomUUID();
      const displayName = generate();
      try {
        return await withTenant(tenantId, async (tx) => {
          await tx.insert(schema.tenants).values({ id: tenantId, name });
          const [user] = await tx
            .insert(schema.users)
            .values({ tenantId, externalIdentityId: sub, email, displayName, role: 'admin' })
            .returning({ id: schema.users.id });
          if (!user) throw new Error('user insert returned no row');
          await tx.insert(schema.userTenantIndex).values({ sub, tenantId });
          return { tenantId, userId: user.id };
        });
      } catch (err) {
        if (isHandleCollision(err) && attempt < MAX_HANDLE_ATTEMPTS - 1) continue;
        if (isSubCollision(err)) throw new ConflictException('already bound to a tenant');
        throw err;
      }
    }
    throw new Error('handle exhausted after max attempts');
  }

  /** Create an invite token for a tenant. Returns the plaintext token once — never stored. */
  async createInvite(auth: VerifiedAuth, inviteeEmail?: string): Promise<CreateInviteResult> {
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
            eq(schema.users.externalIdentityId, auth.sub),
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
          inviteeEmail: inviteeEmail ?? null,
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

  /**
   * Accept an invite — look up by token_hash (withRouting, cross-tenant), validate, then atomically
   * create the user + binding in the invite's tenant. Uniform "invalid or expired" error (no oracle).
   */
  async acceptInvite(
    auth: MaybeUnboundAuth,
    token: string,
    generate: () => string = generateHandle,
  ): Promise<AcceptInviteResult> {
    if (auth.tenantId) throw new ConflictException('already bound to a tenant');
    if (!auth.email)
      throw new BadRequestException('token is missing the email claim required to provision');

    const tokenHash = sha256hex(token);
    const INVALID = 'invalid or expired invite';

    // Cross-tenant lookup: withRouting sets role=argus_app without app.tenant_id. The
    // tenant_invites_accept_flow policy allows this SELECT; column grant limits fields.
    const invite = await withRouting((tx) =>
      tx
        .select({
          id: schema.tenantInvites.id,
          tenantId: schema.tenantInvites.tenantId,
          inviteeEmail: schema.tenantInvites.inviteeEmail,
          expiresAt: schema.tenantInvites.expiresAt,
          acceptedAt: schema.tenantInvites.acceptedAt,
          revokedAt: schema.tenantInvites.revokedAt,
        })
        .from(schema.tenantInvites)
        .where(eq(schema.tenantInvites.tokenHash, tokenHash))
        .limit(1)
        .then((r) => r[0]),
    );

    if (!invite) throw new ForbiddenException(INVALID);
    if (invite.acceptedAt !== null) throw new ForbiddenException(INVALID);
    if (invite.revokedAt !== null) throw new ForbiddenException(INVALID);
    if (invite.expiresAt < new Date()) throw new ForbiddenException(INVALID);

    // Email-hint check (case-folded). If no hint, any verified identity can accept.
    if (invite.inviteeEmail !== null) {
      if ((auth.email ?? '').toLowerCase() !== invite.inviteeEmail.toLowerCase()) {
        throw new ForbiddenException(INVALID);
      }
    }

    const { sub, email } = auth;

    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
      const displayName = generate();
      try {
        return await withTenant(invite.tenantId, async (tx) => {
          // Mark invite accepted atomically — first committer wins for ALL callers (not just same-sub
          // races). The RETURNING check enforces single-use: if accepted_at is already set (another
          // user beat us here), this UPDATE matches 0 rows → uniform INVALID 403, no user is created.
          const [marked] = await tx
            .update(schema.tenantInvites)
            .set({ acceptedAt: new Date() })
            .where(
              and(
                eq(schema.tenantInvites.id, invite.id),
                isNull(schema.tenantInvites.acceptedAt),
                isNull(schema.tenantInvites.revokedAt),
              ),
            )
            .returning({ id: schema.tenantInvites.id });
          if (!marked) throw new ForbiddenException(INVALID);

          const [user] = await tx
            .insert(schema.users)
            .values({
              tenantId: invite.tenantId,
              externalIdentityId: sub,
              email,
              displayName,
              role: 'member',
            })
            .returning({ id: schema.users.id });
          if (!user) throw new Error('user insert returned no row');

          await tx.insert(schema.userTenantIndex).values({ sub, tenantId: invite.tenantId });

          // Record who accepted (audit trail). Second UPDATE is safe: within the same tx, marked.id is set.
          await tx
            .update(schema.tenantInvites)
            .set({ acceptedBy: user.id })
            .where(eq(schema.tenantInvites.id, invite.id));

          return { tenantId: invite.tenantId, userId: user.id };
        });
      } catch (err) {
        if (isHandleCollision(err) && attempt < MAX_HANDLE_ATTEMPTS - 1) continue;
        if (isSubCollision(err)) throw new ConflictException('already bound to a tenant');
        throw err;
      }
    }
    throw new Error('handle exhausted after max attempts');
  }

  /** List active (not accepted, not revoked, not expired) invites for the caller's tenant. */
  async listInvites(auth: VerifiedAuth) {
    return withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.tenantInvites.id,
          inviteeEmail: schema.tenantInvites.inviteeEmail,
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
          email: schema.users.email,
          displayName: schema.users.displayName,
          role: schema.users.role,
        })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, auth.tenantId), eq(schema.users.status, 'active')))
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
  }

  /** Revoke a member (soft-delete, v1). Cannot revoke the last admin. */
  async revokeMember(auth: VerifiedAuth, targetUserId: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const [target] = await tx
        .select({ role: schema.users.role })
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
            ),
          );
        if (admins.length <= 1) throw new ForbiddenException('cannot remove the last admin');
      }

      await tx
        .update(schema.users)
        .set({ status: 'revoked' })
        .where(and(eq(schema.users.id, targetUserId), eq(schema.users.tenantId, auth.tenantId)));
    });
  }
}
