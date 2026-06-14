-- 0029_stripe_event_dedup — idempotency log for Stripe webhook events (audit follow-up COMP-3).
--
-- Stripe delivers webhook events AT-LEAST-ONCE, so the same event id can arrive multiple times. The handlers
-- are already defensive (they re-fetch live subscription state and guard stale subs), so a replay cannot flip
-- entitlements — but reprocessing still does redundant work and emits duplicate `tenant.plan_changed` audit
-- rows. This table makes webhook processing idempotent: the handler INSERTs each event id ON CONFLICT DO
-- NOTHING before dispatch; a conflict means "already processed" → skip.
--
-- Global, NO RLS — exactly like user_tenant_index (0018): this is operational/dedup data, not tenant-scoped.
-- It stores ONLY the Stripe event id, the event type, and a receipt timestamp. No tenant_id, no message
-- content, no PII — so there is nothing for RLS to isolate. argus_app gets INSERT + SELECT only.
--
-- Retention: rows are tiny and low-volume (a handful per subscription change). A periodic prune is a
-- documented follow-up, not built here; the table is bounded in practice by Stripe's own event volume.
create table stripe_events (
  event_id    text        primary key,
  type        text        not null,
  received_at timestamptz not null default now()
);

grant select, insert on stripe_events to argus_app;
