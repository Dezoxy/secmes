# Threat model: billing and plan gating

## 1. Feature & data flow

G8 adds plan tiers (free / pro / enterprise) stored on the `tenants` table, enforced at the NestJS layer. Stripe handles payment; the server never handles raw card data — only Stripe price IDs and customer/subscription IDs (non-secret metadata). Stripe webhooks drive plan assignment after payment.

Data flows:
- **Admin → `POST /billing/checkout`** → server creates a Stripe Customer (if new) and a Checkout Session → returns a Stripe-hosted URL → browser redirects to `stripe.com`. Card data never touches the Argus server.
- **Stripe → `POST /webhooks/stripe`** → signature-verified event → server writes plan columns to `tenants`.
- **Operator → `PATCH /operator/tenants/:id/plan`** → OPERATOR_API_KEY-gated → writes plan columns directly (for manual overrides and pilot customers).
- **All tenant-scoped APIs** → member-limit and SSO-feature gates enforced at the NestJS service layer before any DB write.

## 2. Assets & trust boundaries

Assets:
- `STRIPE_SECRET_KEY` — authorizes all Stripe API calls; must stay in Key Vault.
- `STRIPE_WEBHOOK_SECRET` — validates webhook authenticity; prevents fake events from upgrading plans.
- `OPERATOR_API_KEY` — grants plan write access to any tenant; high-value secret, Key Vault only.
- Plan tier columns on `tenants` — control access to features (member count, SSO).

Trust boundaries:
- Client ↔ Server: clients supply `successUrl`/`cancelUrl`; server validates they are URLs (Zod `.url()`) but does not follow them.
- Stripe ↔ Server: webhook authenticity is verified with `stripe.webhooks.constructEvent`; tampered or replayed events fail signature check.
- Operator ↔ Server: `OPERATOR_API_KEY` bearer token; read at request time from Key Vault credential file, not cached.

## 3. Threats (STRIDE-lite)

**Spoofing:**
- Fake Stripe webhook: mitigated by `constructEvent` HMAC-SHA256 signature verification using `STRIPE_WEBHOOK_SECRET`. A 400 is returned on any mismatch; the event is never processed.
- Replayed / duplicate events: Stripe delivers at-least-once. The webhook checks the global `stripe_events` table (event id PK; no tenant data, no content) and **records the event id only AFTER its handler succeeds** (`INSERT … ON CONFLICT DO NOTHING`). A redelivery of an already-recorded event is skipped; a crash or throw before recording leaves the event unrecorded, so Stripe's retry re-processes it — an event is never marked done without being done (no silent loss, no DELETE/release path needed). Handlers are additionally idempotent (live-state re-fetch + stale-sub guards + absolute writes), so a re-processed redelivery just repeats harmless work; the common success-replay case is deduped, removing duplicate `tenant.plan_changed` audit rows.
- Operator impersonation: OPERATOR_API_KEY must be a long-lived secret from Key Vault. `timingSafeEqual` from `node:crypto` is used for the comparison, eliminating timing oracle attacks.

**Tampering:**
- Limit bypass via race on member creation: member-limit is checked at BOTH `createInvite` and `acceptInvite`. The second check (inside the `withTenant` transaction) is the true race-safe gate.
- Plan downgrade manipulation: no client input flows to plan writes. All plan changes originate from Stripe-verified webhooks or the operator key.
- Webhook tenant-context (the one **sanctioned exception** to "tenant context only from the verified session", `db/index.ts`): the Stripe webhook is the single place a tenantId reaches `withTenant` from a third-party-relayed value (`metadata.tenantId`) rather than the authenticated request. Safe because (a) the body is Stripe-signature-authenticated, and (b) argus is the **sole writer** of `metadata.tenantId`, set under a verified `auth.tenantId` at checkout creation — Stripe's customer portal cannot edit it. Enforcing controls: `checkout.session.completed` cross-checks the session's `metadata.tenantId` against the Stripe Customer's own metadata, and every webhook-derived tenantId is UUID-validated before opening a `withTenant` transaction; a mismatch or malformed value is logged (metadata only) and skipped — never processed, never 500-looped.

**Information disclosure:**
- Stripe secret key exposure: delivered as a Key Vault credential file (`STRIPE_SECRET_KEY_FILE`); never in env at rest, never logged.
- Billing metadata in logs: price IDs and Stripe customer IDs are logged at WARN level only; they are non-secret metadata (price IDs are visible in every Checkout URL, customer IDs carry no payment data). No card data, subscription amounts, or personal billing details are logged.
- `GET /billing/status` returns plan tier and member count (metadata only, no billing PII). Gated by AdminGuard.

**Elevation of privilege:**
- Feature unlock without payment: Stripe webhook fires after payment confirmation; `checkout.session.completed` maps price ID to tier — an unknown price ID is logged and ignored (no upgrade). `customer.subscription.deleted` reverts to free.
- SSO config accessible on free plan: `sso.service.ts` checks `plan.ssoEnabled` at the top of `createSsoConfig`; returns 402 before any Zitadel provisioning.

## 4. Invariant check

1. **Crypto-blind server** — billing touches only plan metadata columns and Stripe IDs; no content or keys involved.
2. **No secret logging** — `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are never logged. Only price IDs (non-secret) and config-missing warnings are emitted.
3. **RLS** — `tenants` has FORCE ROW LEVEL SECURITY (`tenants_self_isolation` policy keyed on `app.tenant_id`); all reads and writes run inside `withTenant(tenantId)` which sets this session variable. No cross-tenant reads possible. Stripe `tenantIdFromCustomer` derives the tenant from the Stripe Customer's metadata (argus-written) instead of a DB lookup; the value is UUID-validated before any `withTenant` transaction, and `checkout.session.completed` additionally cross-checks the session metadata against the customer (see §3 Tampering — the sanctioned webhook exception). The `stripe_events` dedup table is intentionally global / no-RLS (operational data, no tenant_id, no content) — like `user_tenant_index`.
4. **No hand-rolled crypto** — Stripe's `constructEvent` uses the official SDK's HMAC; no primitives in application code.
5. **Secrets via Key Vault** — `STRIPE_SECRET_KEY_FILE`, `STRIPE_WEBHOOK_SECRET_FILE`, `OPERATOR_API_KEY_FILE` follow the credential-file pattern.
6. **No admin content access** — billing surfaces expose plan metadata only; no message content, attachments, or keys involved.

## 5. Decision & mitigations

- Signature verification on every webhook; 400 on failure, no partial processing.
- Member limit checked at create-invite (UX gate) AND accept-invite (race-safe hard gate).
- SSO gate at `createSsoConfig` entry before any Zitadel API call.
- Plan mutations are audit-logged (`tenant.plan_changed` with `actorNote` = `'stripe-webhook'`, `'operator'`, or `'billing'`).
- Operator endpoints excluded from customer-facing OpenAPI spec (`@ApiExcludeController`).
- Webhook endpoint excluded from OpenAPI spec (`@ApiExcludeEndpoint`), marked `@Public()` (JWT not applicable; Stripe's signature is the auth).

Reviewer gates: `security-boundary-auditor` (plan enforcement paths, operator endpoint, webhook surface).

## 6. Residual risk

- **Operator key timing-safety**: `timingSafeEqual` (constant-time) is used — no timing oracle risk.
- **Webhook replay window**: Stripe's `constructEvent` rejects events with a timestamp more than 300 seconds old by default. Replays within that window are deduped via the `stripe_events` table (event id recorded only after a handler succeeds, `ON CONFLICT DO NOTHING`) and skipped on redelivery; a failure before recording lets the retry re-process, and `setPlan` writes absolute values idempotently regardless. **Retention**: `stripe_events` rows are tiny and low-volume (a handful per subscription change); a periodic prune is a documented follow-up, not yet built.
- **Stripe outage**: if Stripe is down, checkout/portal fail gracefully; the plan stays as-is. No plan data is lost.
