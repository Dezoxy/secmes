-- 0010_conversation_receipts — per-member, per-conversation delivery/read HIGH-WATER-MARKS (checkpoint
-- 31). METADATA only (message ids + timestamps, never content): how far each member has received/read.
-- One row per (conversation, member); watermarks advance forward only (enforced in the app upsert).
-- RLS (ENABLE+FORCE+WITH CHECK) on app.tenant_id; composite FKs pin conversation + user to the row tenant.
create table if not exists conversation_receipts (
  id                           uuid primary key default gen_random_uuid(),
  tenant_id                    uuid not null references tenants(id) on delete cascade,
  conversation_id              uuid not null,
  user_id                      uuid not null,
  -- delivered watermark: the message (id + its created_at) the member has received THROUGH, and when.
  delivered_through_message_id uuid,
  delivered_through_created_at timestamptz,
  delivered_at                 timestamptz,
  -- read watermark (only set if the client opts to send read receipts).
  read_through_message_id      uuid,
  read_through_created_at      timestamptz,
  read_at                      timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  -- One receipt row per member per conversation; also the leading-tenant_id lookup/GET path.
  unique (tenant_id, conversation_id, user_id),
  -- A receipt can't reference a conversation or a user in another tenant (defence-in-depth beneath RLS).
  -- Receipts are disposable metadata, so cascade on conversation/user delete is fine (unlike messages).
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
alter table conversation_receipts enable row level security;
alter table conversation_receipts force row level security;
drop policy if exists conversation_receipts_tenant_isolation on conversation_receipts;
create policy conversation_receipts_tenant_isolation on conversation_receipts
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Upsert + advance-in-place; no delete (cleanup cascades from tenant/conversation/user via the owner).
-- Role is argus_app here: it was renamed from secmes_app by 0009, which runs before this migration.
grant select, insert, update on conversation_receipts to argus_app;
