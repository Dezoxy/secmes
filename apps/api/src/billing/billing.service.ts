import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';

import { PlansService } from '../plans/plans.service.js';
import { SsoService } from '../sso/sso.service.js';

const MEMBER_LIMITS: Record<string, number | null> = {
  free: 10,
  pro: 50,
  enterprise: null,
};

const SSO_ENABLED: Record<string, boolean> = {
  free: false,
  pro: true,
  enterprise: true,
};

function resolveSecretKey(): string {
  const file = process.env.STRIPE_SECRET_KEY_FILE;
  if (!file) return '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(file, 'utf8').trim();
}

function resolveWebhookSecret(): string {
  const file = process.env.STRIPE_WEBHOOK_SECRET_FILE;
  if (!file) return '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(file, 'utf8').trim();
}

function priceIdToTier(priceId: string): 'pro' | 'enterprise' | null {
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
  return null;
}

// Map every Stripe subscription status to the subset stored in our DB check constraint.
// Stripe can emit statuses beyond our initial set (e.g. 'unpaid', 'paused', 'incomplete_expired').
const STRIPE_STATUS_MAP: Record<string, string> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete_expired',
  unpaid: 'unpaid',
  paused: 'paused',
};

function sanitizeStatus(raw: string): string {
  return STRIPE_STATUS_MAP[raw] ?? 'incomplete';
}

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: Stripe | null;
  private readonly webhookSecret: string;

  constructor(
    private readonly plans: PlansService,
    private readonly sso: SsoService,
  ) {
    const secretKey = resolveSecretKey();
    this.webhookSecret = resolveWebhookSecret();

    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2026-05-27.dahlia' });
    } else {
      this.stripe = null;
      this.logger.warn('billing: Stripe API key not configured; billing endpoints are no-ops');
    }
  }

  onModuleInit(): void {
    if (this.stripe) {
      if (!process.env.STRIPE_PRO_PRICE_ID)
        this.logger.warn('billing: STRIPE_PRO_PRICE_ID is not set; pro checkout will fail');
      if (!process.env.STRIPE_ENTERPRISE_PRICE_ID)
        this.logger.warn(
          'billing: STRIPE_ENTERPRISE_PRICE_ID is not set; enterprise checkout will fail',
        );
    }
  }

  get configured(): boolean {
    return this.stripe !== null;
  }

  /**
   * Create (or reuse) a Stripe Customer for the tenant, then create a Checkout Session.
   * Returns the Stripe-hosted checkout URL.
   */
  async createCheckoutSession(
    tenantId: string,
    planTier: 'pro' | 'enterprise',
    tenantName: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const stripe = this.requireStripe();
    const priceId = this.requirePriceId(planTier);

    const plan = await this.plans.getPlan(tenantId);
    let customerId = plan.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        name: tenantName,
        metadata: { tenantId },
      });
      customerId = customer.id;
      await this.plans.setPlan(tenantId, { stripeCustomerId: customerId }, 'billing');
    }

    // If there is already an active subscription, update its price in-place so the
    // tenant is never billed for two concurrent subscriptions.
    if (plan.stripeSubscriptionId) {
      const existing = await stripe.subscriptions.retrieve(plan.stripeSubscriptionId);
      if (existing.status === 'active' || existing.status === 'trialing') {
        const itemId = existing.items.data[0]?.id;
        if (!itemId) throw new Error('existing subscription has no line items');
        await stripe.subscriptions.update(plan.stripeSubscriptionId, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
        });
        // Return successUrl directly; customer.subscription.updated webhook will set the new tier.
        return successUrl;
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { tenantId },
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return session.url;
  }

  /** Create a Stripe Billing Portal session so the tenant admin can manage their subscription. */
  async createPortalSession(tenantId: string, returnUrl: string): Promise<string> {
    const stripe = this.requireStripe();
    const plan = await this.plans.getPlan(tenantId);
    if (!plan.stripeCustomerId) {
      throw new Error('no Stripe customer for this tenant — subscribe first');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: plan.stripeCustomerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  /** Verify the Stripe webhook signature and return the parsed event. Throws on mismatch. */
  verifyWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const stripe = this.requireStripe();
    if (!this.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
    return stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  /** Handle a verified Stripe webhook event — update plan tier and subscription status. */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenantId;
        if (!tenantId || !session.subscription) break;

        const subscriptionId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id;

        const sub = await this.requireStripe().subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0]?.price.id ?? '';
        const tier = priceIdToTier(priceId);
        if (!tier) {
          this.logger.warn(`billing: unknown price ${priceId} in checkout.session.completed`);
          break;
        }

        // Use actual subscription status — Stripe doesn't guarantee event ordering,
        // so the sub may already be canceled by the time this event is processed.
        const status = sanitizeStatus(sub.status);
        if (status !== 'active' && status !== 'trialing') {
          this.logger.warn(
            `billing: checkout.session.completed for sub ${subscriptionId} has status ${status} — skipping upgrade`,
          );
          break;
        }

        await this.plans.setPlan(
          tenantId,
          {
            planTier: tier,
            memberLimit: MEMBER_LIMITS[tier] ?? null,
            ssoEnabled: SSO_ENABLED[tier] ?? false,
            stripeSubscriptionId: subscriptionId,
            subscriptionStatus: status,
          },
          'stripe-webhook',
        );
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const tenantId = await this.tenantIdFromCustomer(sub.customer as string);
        if (!tenantId) break;

        const priceId = sub.items.data[0]?.price.id ?? '';
        const tier = priceIdToTier(priceId);
        const status = sanitizeStatus(sub.status);

        // Only upgrade entitlements (tier/memberLimit/ssoEnabled) when the subscription
        // is actively entitled. For non-entitled statuses (past_due, unpaid, paused, etc.)
        // update the status only so the UI shows the right warning; definitive downgrade
        // happens on customer.subscription.deleted.
        const entitled = status === 'active' || status === 'trialing';

        await this.plans.setPlan(
          tenantId,
          {
            ...(entitled && tier
              ? {
                  planTier: tier,
                  memberLimit: MEMBER_LIMITS[tier] ?? null,
                  ssoEnabled: SSO_ENABLED[tier] ?? false,
                }
              : {}),
            subscriptionStatus: status,
          },
          'stripe-webhook',
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const tenantId = await this.tenantIdFromCustomer(sub.customer as string);
        if (!tenantId) break;

        // Guard against stale-sub deletion: when Pro→Enterprise upgrade creates a new
        // subscription, Stripe later deletes the old Pro sub. Only downgrade when the
        // deleted sub matches the tenant's current active subscription.
        const currentPlan = await this.plans.getPlan(tenantId);
        if (currentPlan.stripeSubscriptionId && currentPlan.stripeSubscriptionId !== sub.id) {
          this.logger.log(
            `billing: ignoring deletion of stale sub ${sub.id} for tenant ${tenantId}`,
          );
          break;
        }

        await this.plans.setPlan(
          tenantId,
          {
            planTier: 'free',
            memberLimit: MEMBER_LIMITS.free,
            ssoEnabled: false,
            stripeSubscriptionId: null,
            subscriptionStatus: 'canceled',
          },
          'stripe-webhook',
        );
        // Delete the SSO config row so that SSO-issued tokens issued before cancellation
        // cannot be used to bypass the ssoEnabled=false gate (Zitadel deletion is best-effort).
        await this.sso.disableSsoForTenant(tenantId);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        const tenantId = await this.tenantIdFromCustomer(customerId);
        if (!tenantId) break;

        await this.plans.setPlan(tenantId, { subscriptionStatus: 'past_due' }, 'stripe-webhook');
        break;
      }

      default:
        // Unhandled event type — not an error, Stripe sends many event types.
        break;
    }
  }

  private requireStripe(): Stripe {
    if (!this.stripe) throw new Error('Stripe is not configured');
    return this.stripe;
  }

  private requirePriceId(tier: 'pro' | 'enterprise'): string {
    const id =
      tier === 'pro' ? process.env.STRIPE_PRO_PRICE_ID : process.env.STRIPE_ENTERPRISE_PRICE_ID;
    if (!id) throw new Error(`STRIPE_${tier.toUpperCase()}_PRICE_ID is not set`);
    return id;
  }

  private async tenantIdFromCustomer(customerId: string): Promise<string | null> {
    const customer = await this.requireStripe().customers.retrieve(customerId);
    if (customer.deleted) return null;
    return (customer.metadata?.tenantId as string | undefined) ?? null;
  }
}
