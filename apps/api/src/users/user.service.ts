import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  PrivacySettings,
  UpdatePrivacySettings,
  UpdateProfile,
  UserLookupResult,
} from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

export interface UserRecord {
  id: string;
  argusId: string;
  displayName: string | null;
  avatarSeed: string | null;
  role: string;
}

// Identity projection for /me (getByAuth). Mapped to UserRecord — not exposed verbatim.
const ME_SELECTION = {
  id: schema.users.id,
  argusId: schema.users.argusId,
  displayName: schema.users.displayName,
  avatarSeed: schema.users.avatarSeed,
  role: schema.users.role,
} as const;

// Privacy settings projection for GET /me/settings/privacy.
const PRIVACY_SELECTION = {
  privacyReadReceipts: schema.users.privacyReadReceipts,
  privacyTypingIndicators: schema.users.privacyTypingIndicators,
  privacyLinkPreviews: schema.users.privacyLinkPreviews,
} as const;

const DEFAULT_PRIVACY: PrivacySettings = {
  readReceipts: true,
  typingIndicators: true,
  linkPreviews: true,
};

@Injectable()
export class UserService {
  /** Read the user for a verified identity within their tenant. Undefined if not yet provisioned. */
  async getByAuth(auth: VerifiedAuth): Promise<UserRecord | undefined> {
    const [user] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .select(ME_SELECTION)
        .from(schema.users)
        // RLS already scopes to the tenant; the explicit tenant_id predicate is defense-in-depth.
        .where(
          and(
            auth.userId
              ? eq(schema.users.id, auth.userId)
              : eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );
    if (!user) return undefined;
    return {
      id: user.id,
      argusId: user.argusId,
      displayName: user.displayName,
      avatarSeed: user.avatarSeed,
      role: user.role,
    };
  }

  /**
   * Exact-match lookup by argus-id. Returns null for both "not found" and "found but inactive"
   * (uniform not-found — no oracle for inactive/suspended users; see discovery-by-argus-id.md).
   */
  async lookupByArgusId(tenantId: string, argusId: string): Promise<UserLookupResult | null> {
    const [row] = await withTenant(tenantId, async (tx) =>
      tx
        .select({
          userId: schema.users.id,
          argusId: schema.users.argusId,
          displayName: schema.users.displayName,
          avatarSeed: schema.users.avatarSeed,
        })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, tenantId),
            eq(schema.users.argusId, argusId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }

  /**
   * Update the caller's own display name and/or avatar seed. Only provided fields are updated.
   * argusId is not in the schema — immutability is enforced by Zod (unknown fields stripped) and
   * the `users_argus_id_immutable` DB trigger.
   */
  async updateProfile(
    auth: { tenantId: string; userId: string },
    dto: UpdateProfile,
  ): Promise<void> {
    if (!dto.displayName && !dto.avatarSeed) return;
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (dto.displayName !== undefined) set.displayName = dto.displayName;
    if (dto.avatarSeed !== undefined) set.avatarSeed = dto.avatarSeed;
    const result = await withTenant(auth.tenantId, async (tx) =>
      tx
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, auth.userId), eq(schema.users.tenantId, auth.tenantId)))
        .returning({ id: schema.users.id }),
    );
    if (result.length === 0) throw new NotFoundException('user not found');
  }

  /** Read the caller's privacy preference settings. Returns defaults when the user is not found. */
  async getPrivacySettings(auth: VerifiedAuth): Promise<PrivacySettings> {
    const [row] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .select(PRIVACY_SELECTION)
        .from(schema.users)
        .where(
          and(
            auth.userId
              ? eq(schema.users.id, auth.userId)
              : eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );
    if (!row) return DEFAULT_PRIVACY;
    return {
      readReceipts: row.privacyReadReceipts ?? true,
      typingIndicators: row.privacyTypingIndicators ?? true,
      linkPreviews: row.privacyLinkPreviews ?? true,
    };
  }

  /**
   * Persist the caller's privacy preference settings. Only supplied fields are written.
   * Silent no-op when the user row is not found — consistent with updateProfile.
   */
  async updatePrivacySettings(
    auth: { tenantId: string; userId: string },
    dto: UpdatePrivacySettings,
  ): Promise<void> {
    const hasUpdate =
      dto.readReceipts !== undefined ||
      dto.typingIndicators !== undefined ||
      dto.linkPreviews !== undefined;
    if (!hasUpdate) return;

    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (dto.readReceipts !== undefined) set.privacyReadReceipts = dto.readReceipts;
    if (dto.typingIndicators !== undefined) set.privacyTypingIndicators = dto.typingIndicators;
    if (dto.linkPreviews !== undefined) set.privacyLinkPreviews = dto.linkPreviews;

    await withTenant(auth.tenantId, async (tx) =>
      tx
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, auth.userId), eq(schema.users.tenantId, auth.tenantId))),
    );
  }
}
