import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, isNull, ne, or } from 'drizzle-orm';
import type { TenantPlan, UpdateProfile, UserLookupResult } from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

export interface UserRecord {
  id: string;
  argusId: string;
  displayName: string | null;
  avatarSeed: string | null;
  role: string;
  plan?: TenantPlan;
}

// Identity projection for /me (getByAuth). Mapped to UserRecord — not exposed verbatim.
const ME_SELECTION = {
  id: schema.users.id,
  argusId: schema.users.argusId,
  displayName: schema.users.displayName,
  avatarSeed: schema.users.avatarSeed,
  role: schema.users.role,
} as const;

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

    // Fetch plan columns + active member count (excludes breakglass-admin) in a second
    // tenant-scoped transaction. Needed by /me for billing-aware settings UI (removed in Phase 5
    // once the frontend fetches /billing/status independently).
    const [tenantRow, countRow] = await withTenant(auth.tenantId, async (tx) => {
      const [plan] = await tx
        .select({
          planTier: schema.tenants.planTier,
          memberLimit: schema.tenants.memberLimit,
          ssoEnabled: schema.tenants.ssoEnabled,
          subscriptionStatus: schema.tenants.subscriptionStatus,
        })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, auth.tenantId))
        .limit(1);
      const [cnt] = await tx
        .select({ count: count() })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.status, 'active'),
            or(isNull(schema.users.displayName), ne(schema.users.displayName, 'breakglass-admin')),
          ),
        );
      return [plan, cnt] as const;
    });

    return {
      id: user.id,
      argusId: user.argusId,
      displayName: user.displayName,
      avatarSeed: user.avatarSeed,
      role: user.role,
      plan: {
        tier: (tenantRow?.planTier ?? 'free') as TenantPlan['tier'],
        memberLimit: tenantRow?.memberLimit ?? null,
        ssoEnabled: tenantRow?.ssoEnabled ?? false,
        memberCount: countRow?.count ?? 0,
        subscriptionStatus:
          (tenantRow?.subscriptionStatus as TenantPlan['subscriptionStatus']) ?? null,
      },
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
}
