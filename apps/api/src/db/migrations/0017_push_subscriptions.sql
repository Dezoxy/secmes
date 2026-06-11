-- Web Push subscriptions (roadmap #40). One row per device. The server fans a content-free VAPID ping
-- here after each message store (notifyConversationMembers). No message content, no keys, no plaintext —
-- only the push-service endpoint + RFC 8291 transport-encryption keys. Threat model: web-push.md.

create table if not exists push_subscriptions (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null,
  device_id   uuid        not null,
  user_id     uuid        not null,   -- denorm: fast fan-out lookup (tenant_id, user_id)
  endpoint    text        not null,   -- https:// push service URL (≤2048 chars; SSRF-guarded in app layer)
  p256dh      text        not null,   -- base64url RFC 8291 receiver public key
  auth        text        not null,   -- base64url RFC 8291 auth secret
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, device_id)       -- one subscription per device; upsert target
);

-- Composite FK: device must exist in the same tenant; cascade on device delete (clean removal on revoke).
alter table push_subscriptions
  add constraint push_subscriptions_device_fk
  foreign key (tenant_id, device_id)
  references devices (tenant_id, id)
  on delete cascade;

-- RLS — tenant isolation (same pattern as every other tenant-scoped table).
alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;

create policy push_subscriptions_tenant_isolation on push_subscriptions
  using  (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Member-lookup index: notifyConversationMembers JOINs conversation_members ON (tenant_id, user_id).
create index if not exists push_subscriptions_user_idx
  on push_subscriptions (tenant_id, user_id);

-- argus_app: full CRUD (upsert on register, delete on unsubscribe / 410 self-heal).
grant select, insert, update, delete on push_subscriptions to argus_app;
