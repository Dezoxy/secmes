-- 0007_messaging — Phase-3 1:1 (and later group) encrypted text. Three tenant-scoped tables, all
-- CIPHERTEXT-ONLY for content: the server stores and forwards opaque MLS wire bytes + routing metadata
-- and never decrypts. RLS (ENABLE+FORCE+WITH CHECK) keyed on app.tenant_id isolates tenants; intra-tenant
-- conversation-membership authz is the app layer's job (checkpoint 26). See messaging-schema.md.

-- users.id is globally unique (PK), so a single-column FK to it can't tell tenants apart. Add a
-- tenant-scoped unique key so the messaging FKs below can pin every user reference to the ROW's tenant
-- — a tenant-B row then cannot reference a tenant-A user (and an A-user delete can't cascade into B).
do $$ begin
  alter table users add constraint users_tenant_id_id_key unique (tenant_id, id);
exception when duplicate_object then null;
end $$;

-- A conversation / MLS group. Metadata only — deliberately NO name/title (that would be plaintext
-- metadata; 1:1 needs none, and a future group name must be encrypted client-side).
create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  -- created_by must be a user IN THIS tenant (composite FK, not the global users.id). NO ACTION (not
  -- cascade): deleting a user must NOT destroy conversations they created (and everyone's messages in
  -- them). It blocks a direct user delete that would orphan a conversation, but a TENANT teardown still
  -- cascades (the end-of-statement check passes when the users + conversations go together).
  foreign key (tenant_id, created_by) references users (tenant_id, id) on delete no action,
  -- FK target for child rows so their tenant_id MUST equal this conversation's tenant (see below).
  unique (tenant_id, id)
);
alter table conversations enable row level security;
alter table conversations force row level security;
drop policy if exists conversations_tenant_isolation on conversations;
create policy conversations_tenant_isolation on conversations
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
create index if not exists conversations_tenant_idx on conversations (tenant_id, created_at);

-- Who belongs to a conversation (user-level). Drives send/read authz at the app layer (26).
create table if not exists conversation_members (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null,
  user_id         uuid not null,
  joined_at       timestamptz not null default now(),
  -- Composite FKs pin BOTH the conversation and the user to this row's tenant — a membership can't
  -- reference a conversation or a user in another tenant (defence-in-depth beneath RLS).
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade
);
alter table conversation_members enable row level security;
alter table conversation_members force row level security;
drop policy if exists conversation_members_tenant_isolation on conversation_members;
create policy conversation_members_tenant_isolation on conversation_members
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- One membership row per (conversation, user); also the leading-tenant_id membership-lookup path.
create unique index if not exists conversation_members_unique_idx
  on conversation_members (tenant_id, conversation_id, user_id);
-- "Which conversations is this user in?" — leading tenant_id.
create index if not exists conversation_members_user_idx
  on conversation_members (tenant_id, user_id);

-- Messages: CIPHERTEXT ONLY. `ciphertext` is the opaque base64 MLS wire blob (server never parses it);
-- `alg`/`epoch`/`client_message_id`/`attachment_object_key` are routing/version/dedup metadata only.
create table if not exists messages (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  conversation_id       uuid not null,
  sender_user_id        uuid not null,
  client_message_id     uuid not null,                 -- client-generated; idempotency + optimistic UI
  ciphertext            text not null,                 -- opaque MLS ciphertext (base64); never decrypted
  alg                   text not null,                 -- AEAD/version tag, e.g. "MLS_1.0"
  epoch                 bigint not null check (epoch >= 0), -- MLS epoch; selects recipient ratchet state
  attachment_object_key text,                          -- optional ref to an uploaded ENCRYPTED blob
  created_at            timestamptz not null default now(),
  -- Composite FKs pin BOTH the conversation and the sender to this row's tenant (defence-in-depth
  -- beneath RLS): a message can't reference a conversation or a user in another tenant.
  -- conversation: CASCADE — deleting a conversation removes its messages (the conversation is gone).
  -- sender: NO ACTION — deleting a USER must NOT erase their message history through a parent delete
  -- (append-only). Blocks a direct user delete; a TENANT teardown still cascades both together.
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  foreign key (tenant_id, sender_user_id) references users (tenant_id, id) on delete no action
);
alter table messages enable row level security;
alter table messages force row level security;
drop policy if exists messages_tenant_isolation on messages;
create policy messages_tenant_isolation on messages
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- Fetch a conversation's messages chronologically — leading tenant_id.
create index if not exists messages_conversation_idx
  on messages (tenant_id, conversation_id, created_at);
-- Idempotent send: a sender's client_message_id is unique (a retry can't duplicate).
create unique index if not exists messages_idempotency_idx
  on messages (tenant_id, sender_user_id, client_message_id);

-- Conversations + members are mutable membership; messages are APPEND-ONLY (no update/delete grant —
-- edits/retention are later features). Deletes cascade from tenants/conversations via the owner role.
grant select, insert on conversations to argus_app;
grant select, insert, delete on conversation_members to argus_app;
grant select, insert on messages to argus_app;
