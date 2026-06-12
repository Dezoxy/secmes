-- G8: Billing / plan gating — plan tier + Stripe subscription columns on tenants.
-- `tenants` has FORCE ROW LEVEL SECURITY (tenants_self_isolation policy, keyed on app.tenant_id).
-- All reads and writes must run inside withTenant(tenantId) which sets the session variable.

ALTER TABLE tenants
  ADD COLUMN plan_tier              text        NOT NULL DEFAULT 'free'
                                    CHECK (plan_tier IN ('free', 'pro', 'enterprise')),
  ADD COLUMN member_limit           int                  DEFAULT 10,
  ADD COLUMN sso_enabled            boolean     NOT NULL DEFAULT false,
  ADD COLUMN plan_set_at            timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN stripe_customer_id     text        UNIQUE,
  ADD COLUMN stripe_subscription_id text        UNIQUE,
  ADD COLUMN subscription_status    text
                                    CHECK (subscription_status IN
                                      ('active', 'trialing', 'past_due', 'canceled', 'incomplete',
                                       'incomplete_expired', 'unpaid', 'paused'));
