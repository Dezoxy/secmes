import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { BillingService } from './billing.service.js';
import type { PlansService } from '../plans/plans.service.js';

// vi.hoisted runs before module imports so the mock factory can reference it.
const mockStripeInstance = vi.hoisted(() => ({
  customers: { create: vi.fn().mockResolvedValue({ id: 'cus_test' }) },
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }),
    },
  },
  billingPortal: {
    sessions: {
      create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/test' }),
    },
  },
  subscriptions: {
    retrieve: vi.fn().mockResolvedValue({
      id: 'sub_test',
      items: { data: [{ price: { id: 'price_pro' } }] },
      status: 'active',
    }),
  },
  webhooks: { constructEvent: vi.fn() },
}));

vi.mock('stripe', () => ({
  default: function MockStripe() {
    return mockStripeInstance;
  },
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
      }),
    },
  }),
  schema: { tenants: { stripeCustomerId: 'stripeCustomerId', id: 'id' } },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

function makePlans(overrides?: Partial<PlansService>) {
  return {
    getPlan: vi.fn().mockResolvedValue({
      tier: 'free',
      memberLimit: 10,
      ssoEnabled: false,
      memberCount: 1,
      subscriptionStatus: null,
      stripeCustomerId: null,
    }),
    setPlan: vi.fn().mockResolvedValue(undefined),
    getTenantName: vi.fn().mockResolvedValue('Acme Corp'),
    countActiveMembers: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as PlansService;
}

describe('BillingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRO_PRICE_ID = 'price_pro';
    process.env.STRIPE_ENTERPRISE_PRICE_ID = 'price_enterprise';
    delete process.env.STRIPE_SECRET_KEY_FILE;
    delete process.env.STRIPE_WEBHOOK_SECRET_FILE;
  });

  it('createCheckoutSession creates a new Stripe customer when none exists and returns the URL', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans);

    const url = await svc.createCheckoutSession(
      'tenant-1',
      'pro',
      'Acme Corp',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );

    expect(url).toBe('https://checkout.stripe.com/test');
    expect(plans.setPlan).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ stripeCustomerId: 'cus_test' }),
      'billing',
    );
  });

  it('createCheckoutSession reuses existing Stripe customer', async () => {
    const plans = makePlans({
      getPlan: vi.fn().mockResolvedValue({
        tier: 'free',
        memberLimit: 10,
        ssoEnabled: false,
        memberCount: 1,
        subscriptionStatus: null,
        stripeCustomerId: 'cus_existing',
      }),
    });
    const svc = new BillingService(plans);

    const url = await svc.createCheckoutSession(
      'tenant-1',
      'pro',
      'Acme Corp',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );

    expect(url).toBe('https://checkout.stripe.com/test');
    expect(plans.setPlan).not.toHaveBeenCalled();
  });

  it('handleWebhookEvent checkout.session.completed upgrades plan to pro', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans);

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenantId: 'tenant-1' },
          subscription: 'sub_test',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        planTier: 'pro',
        memberLimit: 50,
        ssoEnabled: true,
        subscriptionStatus: 'active',
      }),
      'stripe-webhook',
    );
  });

  it('handleWebhookEvent customer.subscription.deleted reverts to free', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans);

    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_test',
          items: { data: [] },
        } as unknown as Stripe.Subscription,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ planTier: 'free', subscriptionStatus: 'canceled' }),
      'stripe-webhook',
    );
  });

  it('handleWebhookEvent invoice.payment_failed sets past_due', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans);

    const event = {
      type: 'invoice.payment_failed',
      data: {
        object: { customer: 'cus_test' } as unknown as Stripe.Invoice,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).toHaveBeenCalledWith(
      'tenant-1',
      { subscriptionStatus: 'past_due' },
      'stripe-webhook',
    );
  });

  it('is a no-op when STRIPE_SECRET_KEY is not set', () => {
    delete process.env.STRIPE_SECRET_KEY;
    const plans = makePlans();
    const svc = new BillingService(plans);

    expect(svc.configured).toBe(false);
    return expect(
      svc.createCheckoutSession('t1', 'pro', 'Acme', 'https://a.com', 'https://b.com'),
    ).rejects.toThrow('Stripe is not configured');
  });
});
