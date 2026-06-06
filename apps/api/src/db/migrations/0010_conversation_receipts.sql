-- 0010_conversation_receipts — per-member, per-conversation delivery/read HIGH-WATER-MARKS (checkpoint
-- 31). METADATA only (message ids + timestamps, never content): how far each member has received/read.
-- One row per (conversation, member); watermarks advance forward only (enforced in the app upsert).
-- RLS (ENABLE+FORCE+WITH CHECK) on app.tenant_id; a composite FK pins the (conversation, user) MEMBERSHIP
-- to the row tenant and ties the receipt's lifecycle to that membership.
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
  -- A receipt is OWNED BY its membership: it exists only while the (conversation, user) pair is a current
  -- member. One composite FK to conversation_members pins all three columns to this tenant (defence-in-depth
  -- beneath RLS — stronger than separate conversation/user FKs, which can't force a real membership pair)
  -- AND cascades cleanup when the membership is removed, so a removed-then-re-added member starts with a
  -- clean watermark instead of resurfacing a stale one. Conversation/user/tenant teardown still cascades
  -- transitively (a membership cascades from all three). Receipts are disposable, so the delete is safe.
  foreign key (tenant_id, conversation_id, user_id)
    references conversation_members (tenant_id, conversation_id, user_id) on delete cascade
);
alter table conversation_receipts enable row level security;
alter table conversation_receipts force row level security;
drop policy if exists conversation_receipts_tenant_isolation on conversation_receipts;
create policy conversation_receipts_tenant_isolation on conversation_receipts
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Upsert + advance-in-place; no delete grant (cleanup cascades from the membership — and transitively
-- tenant/conversation/user — via the owner role).
-- Role is argus_app here: it was renamed from secmes_app by 0009, which runs before this migration.
grant select, insert, update on conversation_receipts to argus_app;
