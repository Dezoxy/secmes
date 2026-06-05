-- 0002_audit_events — tenant-scoped, append-only audit log (roadmap 16).
-- IDs + metadata ONLY. No message content, tokens, keys, passphrases, or Authorization headers.

create table if not exists audit_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  event_type  text not null,            -- e.g. 'auth.login', 'auth.logout'
  actor_sub   text,                     -- verified OIDC subject (identifier, not a token)
  ip          inet,                     -- source IP (metadata; accurate only with trust-proxy)
  user_agent  text,                     -- client hint (metadata)
  metadata    jsonb,                    -- NON-SENSITIVE context only — never content/secrets
  created_at  timestamptz not null default now()
);
alter table audit_events enable row level security;
alter table audit_events force row level security;
drop policy if exists audit_events_tenant_isolation on audit_events;
create policy audit_events_tenant_isolation on audit_events
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
create index if not exists audit_events_tenant_idx on audit_events (tenant_id, created_at desc);

-- Append-only for the runtime: INSERT + SELECT only, NO update/delete → the app cannot rewrite
-- history. Retention (90-day prune) runs out-of-band as a maintenance/worker job, tenant-by-tenant.
grant select, insert on audit_events to secmes_app;
