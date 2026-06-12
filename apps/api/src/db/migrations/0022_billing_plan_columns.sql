-- G8: Billing / plan gating — plan tier + Stripe subscription columns on tenants.
-- `tenants` has no per-row RLS (it is the root entity), so withRouting / direct queries can write
-- to these columns cross-tenant for the operator endpoint and the Stripe webhook handler.

ALTER TABLE tenants
  ADD COLUMN plan_tier              text        NOT NULL DEFAULT 'free'
                                    CHECK (plan_tier IN ('free', 'pro', 'enterprise')),
  ADD COLUMN member_limit           int         NOT NULL DEFAULT 10,
  ADD COLUMN sso_enabled            boolean     NOT NULL DEFAULT false,
  ADD COLUMN plan_set_at            timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN stripe_customer_id     text        UNIQUE,
  ADD COLUMN stripe_subscription_id text        UNIQUE,
  ADD COLUMN subscription_status    text
                                    CHECK (subscription_status IN
                                      ('active', 'trialing', 'past_due', 'canceled', 'incomplete'));
