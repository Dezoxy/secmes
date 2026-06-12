import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlansService } from './plans.service.js';
import type { AuditService } from '../audit/audit.service.js';

const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getDb: () => ({ db: mockDb }),
  schema: {
    tenants: {
      id: 'id',
      planTier: 'plan_tier',
      memberLimit: 'member_limit',
      ssoEnabled: 'sso_enabled',
      stripeCustomerId: 'stripe_customer_id',
      subscriptionStatus: 'subscription_status',
      name: 'name',
    },
    users: {
      tenantId: 'tenant_id',
      status: 'status',
    },
  },
  withTenant: vi.fn((_tenantId: string, fn: (tx: unknown) => unknown) => {
    // Run the callback with the mock db so tests can configure it via mockDb.select
    return fn(mockDb);
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  count: vi.fn(() => 'COUNT(*)'),
}));

function buildSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  mockDb.select.mockReturnValueOnce(chain);
  return chain;
}

function makeAudit(record = vi.fn().mockResolvedValue(undefined)) {
  return { record } as unknown as AuditService;
}

describe('PlansService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPlan', () => {
    it('returns plan data with memberCount', async () => {
      const svc = new PlansService(makeAudit());
      vi.spyOn(svc, 'countActiveMembers').mockResolvedValue(3);

      buildSelectChain([
        {
          planTier: 'free',
          memberLimit: 10,
          ssoEnabled: false,
          stripeCustomerId: null,
          subscriptionStatus: null,
        },
      ]);

      const plan = await svc.getPlan('tenant-1');

      expect(plan.tier).toBe('free');
      expect(plan.memberLimit).toBe(10);
      expect(plan.memberCount).toBe(3);
      expect(plan.ssoEnabled).toBe(false);
    });

    it('throws NotFoundException when tenant is not found', async () => {
      const svc = new PlansService(makeAudit());
      vi.spyOn(svc, 'countActiveMembers').mockResolvedValue(0);

      buildSelectChain([]); // tenant not found

      await expect(svc.getPlan('missing-tenant')).rejects.toThrow(NotFoundException);
    });
  });

  describe('setPlan', () => {
    it('updates plan columns and records audit event', async () => {
      const mockRecord = vi.fn().mockResolvedValue(undefined);
      const svc = new PlansService(makeAudit(mockRecord));

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
      });

      await svc.setPlan('tenant-1', { planTier: 'pro', ssoEnabled: true }, 'operator');

      expect(mockRecord).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ eventType: 'tenant.plan_changed', actorSub: 'operator' }),
      );
    });

    it('throws NotFoundException when tenant is not found', async () => {
      const svc = new PlansService(makeAudit());

      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([]),
      });

      await expect(svc.setPlan('missing', { planTier: 'pro' })).rejects.toThrow(NotFoundException);
    });
  });
});
