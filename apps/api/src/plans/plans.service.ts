import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import type { TenantPlan } from '@argus/contracts';

import { AuditService } from '../audit/audit.service.js';
import { getDb, schema } from '../db/index.js';

export interface PlanPatch {
  planTier?: 'free' | 'pro' | 'enterprise';
  memberLimit?: number | null;
  ssoEnabled?: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
}

@Injectable()
export class PlansService {
  constructor(private readonly audit: AuditService) {}

  /** Read the plan columns for a tenant. `tenants` has no RLS — direct query is safe. */
  async getPlan(tenantId: string): Promise<TenantPlan & { stripeCustomerId: string | null }> {
    const { db } = getDb();
    const [row] = await db
      .select({
        planTier: schema.tenants.planTier,
        memberLimit: schema.tenants.memberLimit,
        ssoEnabled: schema.tenants.ssoEnabled,
        stripeCustomerId: schema.tenants.stripeCustomerId,
        subscriptionStatus: schema.tenants.subscriptionStatus,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1);

    if (!row) throw new NotFoundException('tenant not found');

    const memberCount = await this.countActiveMembers(tenantId);

    return {
      tier: row.planTier as TenantPlan['tier'],
      memberLimit: row.memberLimit,
      ssoEnabled: row.ssoEnabled,
      memberCount,
      subscriptionStatus: (row.subscriptionStatus as TenantPlan['subscriptionStatus']) ?? null,
      stripeCustomerId: row.stripeCustomerId ?? null,
    };
  }

  /** Write plan columns for any tenant. `tenants` has no RLS so no withTenant needed. */
  async setPlan(tenantId: string, patch: PlanPatch, actorNote?: string): Promise<void> {
    const { db } = getDb();
    const update: Record<string, unknown> = { planSetAt: new Date() };
    if (patch.planTier !== undefined) update.planTier = patch.planTier;
    if (patch.memberLimit !== undefined) update.memberLimit = patch.memberLimit;
    if (patch.ssoEnabled !== undefined) update.ssoEnabled = patch.ssoEnabled;
    if (patch.stripeCustomerId !== undefined) update.stripeCustomerId = patch.stripeCustomerId;
    if (patch.stripeSubscriptionId !== undefined)
      update.stripeSubscriptionId = patch.stripeSubscriptionId;
    if (patch.subscriptionStatus !== undefined)
      update.subscriptionStatus = patch.subscriptionStatus;

    const updated = await db
      .update(schema.tenants)
      .set(update)
      .where(eq(schema.tenants.id, tenantId))
      .returning({ id: schema.tenants.id });

    if (!updated.length) throw new NotFoundException('tenant not found');

    await this.audit.record(tenantId, {
      eventType: 'tenant.plan_changed',
      actorSub: actorNote ?? 'system',
    });
  }

  /** Fetch the tenant's display name — used by BillingService when creating a Stripe Customer. */
  async getTenantName(tenantId: string): Promise<string> {
    const { db } = getDb();
    const [row] = await db
      .select({ name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('tenant not found');
    return row.name;
  }

  /** COUNT active (non-revoked) members within a tenant. Used for member-limit enforcement. */
  async countActiveMembers(tenantId: string): Promise<number> {
    const { db } = getDb();
    const [row] = await db
      .select({ count: count() })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.status, 'active')));
    return row?.count ?? 0;
  }
}
