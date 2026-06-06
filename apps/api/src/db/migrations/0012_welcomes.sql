-- 0012_welcomes — MLS Welcome delivery (live client loop). The missing relay between the key directory
-- (#19) and a live conversation: when a member adds a new member (MLS addMember → opaque Welcome +
-- RatchetTree), the inviter delivers them HERE for the recipient; the recipient fetches their pending
-- welcomes on connect, joinConversation()s, then consumes (deletes) the row. CIPHERTEXT-ONLY: welcome +
-- ratchet_tree are opaque MLS base64 the server NEVER decrypts (they carry group key material sealed to
-- the recipient's KeyPackage HPKE key). RLS (ENABLE+FORCE+WITH CHECK) + composite-FK tenant pinning.
-- See welcome-delivery.md.
create table if not exists conversation_welcomes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  conversation_id   uuid not null,
  -- The new member this welcome is FOR. Fetch is scoped to recipient_user_id = the verified caller.
  recipient_user_id uuid not null,
  -- The VERIFIED inviter who delivered it (sub -> user), never client input.
  sender_user_id    uuid not null,
  -- Opaque MLS Welcome + RatchetTree (base64). The server stores + forwards; it never parses/decrypts.
  welcome           text not null,
  ratchet_tree      text not null,
  created_at        timestamptz not null default now(),
  -- The conversation MUST be in this row's tenant. CASCADE — deleting a conversation removes pending welcomes.
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  -- Recipient + sender must be users IN this tenant. NO ACTION (preserve, like messages.sender_user_id);
  -- a TENANT teardown still cascades via tenant_id -> tenants.
  foreign key (tenant_id, recipient_user_id) references users (tenant_id, id) on delete no action,
  foreign key (tenant_id, sender_user_id) references users (tenant_id, id) on delete no action
);
alter table conversation_welcomes enable row level security;
alter table conversation_welcomes force row level security;
drop policy if exists conversation_welcomes_tenant_isolation on conversation_welcomes;
create policy conversation_welcomes_tenant_isolation on conversation_welcomes
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- "My pending welcomes" (fetched on connect) — leading tenant_id.
create index if not exists conversation_welcomes_recipient_idx
  on conversation_welcomes (tenant_id, recipient_user_id);
-- Backs the conversation FK cascade + per-conversation cleanup — leading tenant_id.
create index if not exists conversation_welcomes_conversation_idx
  on conversation_welcomes (tenant_id, conversation_id);

-- Welcomes are TRANSIENT (consumed on join), not append-only: the recipient deletes after joining.
grant select, insert, delete on conversation_welcomes to argus_app;
