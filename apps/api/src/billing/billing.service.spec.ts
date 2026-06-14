import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { BillingService } from './billing.service.js';
import type { PlansService } from '../plans/plans.service.js';
import type { SsoService } from '../sso/sso.service.js';
import type { StripeEventStore } from './stripe-event-store.js';

// A real UUID — the webhook tenant-context guard (COMP-4) rejects non-UUID metadata, so tests must use one.
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// vi.hoisted runs before module imports so the mock factory can reference it.
const mockStripeInstance = vi.hoisted(() => ({
  customers: {
    create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
    retrieve: vi.fn().mockResolvedValue({
      id: 'cus_test',
      deleted: false,
      metadata: { tenantId: '11111111-1111-1111-1111-111111111111' },
    }),
  },
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

// Mock readFileSync so STRIPE_SECRET_KEY_FILE resolves without touching disk.
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('sk_test_fake'),
}));

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

function makeSso(overrides?: Partial<SsoService>) {
  return {
    disableSsoForTenant: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SsoService;
}

// Default: every event is new (isProcessed → false), so handlers run and the event is recorded afterwards.
// Override isProcessed → true to simulate an already-processed redelivery.
function makeStore(overrides?: Partial<StripeEventStore>) {
  return {
    isProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as StripeEventStore;
}

describe('BillingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY_FILE = '/fake/stripe.key';
    process.env.STRIPE_PRO_PRICE_ID = 'price_pro';
    process.env.STRIPE_ENTERPRISE_PRICE_ID = 'price_enterprise';
    delete process.env.STRIPE_WEBHOOK_SECRET_FILE;
  });

  it('createCheckoutSession creates a new Stripe customer when none exists and returns the URL', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans, makeSso(), makeStore());

    const url = await svc.createCheckoutSession(
      TENANT_ID,
      'pro',
      'Acme Corp',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );

    expect(url).toBe('https://checkout.stripe.com/test');
    expect(plans.setPlan).toHaveBeenCalledWith(
      TENANT_ID,
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
    const svc = new BillingService(plans, makeSso(), makeStore());

    const url = await svc.createCheckoutSession(
      TENANT_ID,
      'pro',
      'Acme Corp',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );

    expect(url).toBe('https://checkout.stripe.com/test');
    expect(plans.setPlan).not.toHaveBeenCalled();
  });

  it('handleWebhookEvent checkout.session.completed upgrades plan to pro and records the event', async () => {
    const plans = makePlans();
    const store = makeStore();
    const svc = new BillingService(plans, makeSso(), store);

    const event = {
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenantId: TENANT_ID },
          customer: 'cus_test',
          subscription: 'sub_test',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        planTier: 'pro',
        memberLimit: 50,
        ssoEnabled: true,
        subscriptionStatus: 'active',
      }),
      'stripe-webhook',
    );
    // Recorded only after successful dispatch.
    expect(store.markProcessed).toHaveBeenCalledWith('evt_checkout', 'checkout.session.completed');
  });

  it('handleWebhookEvent customer.subscription.deleted reverts to free and disables SSO', async () => {
    const plans = makePlans();
    const sso = makeSso();
    const svc = new BillingService(plans, sso, makeStore());

    const event = {
      id: 'evt_deleted',
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
      TENANT_ID,
      expect.objectContaining({ planTier: 'free', subscriptionStatus: 'canceled' }),
      'stripe-webhook',
    );
    expect(sso.disableSsoForTenant).toHaveBeenCalledWith(TENANT_ID);
  });

  it('handleWebhookEvent invoice.payment_failed sets past_due', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans, makeSso(), makeStore());

    const event = {
      id: 'evt_invoice',
      type: 'invoice.payment_failed',
      data: {
        object: { customer: 'cus_test' } as unknown as Stripe.Invoice,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).toHaveBeenCalledWith(
      TENANT_ID,
      { subscriptionStatus: 'past_due' },
      'stripe-webhook',
    );
  });

  it('handleWebhookEvent skips an already-processed event without re-dispatching', async () => {
    const plans = makePlans();
    const store = makeStore({ isProcessed: vi.fn().mockResolvedValue(true) }); // already recorded
    const svc = new BillingService(plans, makeSso(), store);

    const event = {
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenantId: TENANT_ID },
          customer: 'cus_test',
          subscription: 'sub_test',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_checkout');
    expect(plans.setPlan).not.toHaveBeenCalled();
    expect(store.markProcessed).not.toHaveBeenCalled();
  });

  it('handleWebhookEvent does NOT record the event when dispatch throws (so Stripe retries re-process it)', async () => {
    const plans = makePlans({
      setPlan: vi.fn().mockRejectedValue(new Error('transient db error')),
    });
    const store = makeStore();
    const svc = new BillingService(plans, makeSso(), store);

    const event = {
      id: 'evt_fail',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenantId: TENANT_ID },
          customer: 'cus_test',
          subscription: 'sub_test',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await expect(svc.handleWebhookEvent(event)).rejects.toThrow('transient db error');
    expect(store.markProcessed).not.toHaveBeenCalled();
  });

  it('handleWebhookEvent skips checkout.session.completed when session metadata disagrees with the customer', async () => {
    const plans = makePlans();
    const svc = new BillingService(plans, makeSso(), makeStore());

    const event = {
      id: 'evt_mismatch',
      type: 'checkout.session.completed',
      data: {
        object: {
          // customer metadata resolves to TENANT_ID (mock), but the session claims a different tenant
          metadata: { tenantId: '22222222-2222-2222-2222-222222222222' },
          customer: 'cus_test',
          subscription: 'sub_test',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await svc.handleWebhookEvent(event);

    expect(plans.setPlan).not.toHaveBeenCalled();
  });

  it('is a no-op when STRIPE_SECRET_KEY_FILE is not set', () => {
    delete process.env.STRIPE_SECRET_KEY_FILE;
    const plans = makePlans();
    const svc = new BillingService(plans, makeSso(), makeStore());

    expect(svc.configured).toBe(false);
    return expect(
      svc.createCheckoutSession(TENANT_ID, 'pro', 'Acme', 'https://a.com', 'https://b.com'),
    ).rejects.toThrow('Stripe is not configured');
  });
});
