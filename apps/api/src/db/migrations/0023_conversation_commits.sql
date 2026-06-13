-- 0023_conversation_commits — B1: MLS group-commit fan-out.
-- The UNIQUE (tenant_id, conversation_id, epoch) constraint is the server-side epoch lock: first
-- INSERT wins, subsequent attempts at the same epoch return "conflict" (no row inserted → 409).
-- `commit` is the opaque base64 mls_private_message frame — crypto-blind (invariant #1).
-- `sender_user_id` is nullable for GDPR erasure parity with messages.sender_user_id.
-- FORCE RLS so even the table owner (superuser queries inside the app) hits the tenant filter.
-- See docs/threat-models/group-membership.md.

create table if not exists conversation_commits (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null,
  conversation_id  uuid        not null,
  -- Nullable: GDPR erasure sets this to NULL post-commit (same parity as messages.sender_user_id).
  sender_user_id   uuid,
  client_commit_id uuid        not null,
  epoch            bigint      not null,
  -- Opaque mls_private_message base64 frame; server stores + forwards, never decrypts (invariant #1).
  commit           text        not null,
  created_at       timestamptz not null default now(),
  -- Epoch lock: first commit at (tenant, conversation, epoch) wins; second gets no-row-inserted → 409.
  unique (tenant_id, conversation_id, epoch),
  -- Idempotency: same sender re-sending the same client_commit_id is a duplicate, not a new commit.
  unique (tenant_id, conversation_id, sender_user_id, client_commit_id),
  -- Tenant pinning: commit's tenant_id MUST match its conversation's tenant_id (no cross-tenant insert).
  foreign key (tenant_id, conversation_id)
    references conversations (tenant_id, id) on delete cascade,
  -- sender_user_id MUST be a user in this tenant (NO ACTION: preserves the commit if the user is deleted;
  -- the sender_user_id is then nulled by GDPR erasure — same lifecycle as messages.sender_user_id).
  foreign key (tenant_id, sender_user_id)
    references users (tenant_id, id) on delete no action
);

alter table conversation_commits enable row level security;
alter table conversation_commits force row level security;
drop policy if exists commits_tenant_isolation on conversation_commits;
create policy commits_tenant_isolation on conversation_commits
  using  (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- "What happened after epoch N in this conversation?" — the drain query (GET ?afterEpoch=N).
create index if not exists ix_commits_tenant_conv_epoch
  on conversation_commits (tenant_id, conversation_id, epoch);

grant select, insert on conversation_commits to argus_app;
-- GDPR erasure nulls sender_user_id (same as messages).
grant update (sender_user_id) on conversation_commits to argus_app;
