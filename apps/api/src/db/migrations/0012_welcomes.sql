-- 0012_welcomes — MLS Welcome delivery (live client loop). The missing relay between the key directory
-- (#19) and a live conversation: when a member adds a new member (MLS addMember → opaque Welcome +
-- RatchetTree), the inviter delivers them HERE for the recipient; the recipient fetches their pending
-- welcomes on connect, joinConversation()s, then consumes (deletes) the row. CIPHERTEXT-ONLY: welcome +
-- ratchet_tree are opaque MLS base64 the server NEVER decrypts (they carry group key material sealed to
-- the recipient's KeyPackage HPKE key). RLS (ENABLE+FORCE+WITH CHECK) + composite-FK tenant pinning.
-- See welcome-delivery.md.

-- The MLS Welcome is HPKE-sealed to ONE device's claimed KeyPackage (key directory #19), so a welcome
-- is bound to a specific recipient DEVICE, not just the user. This composite-FK target lets us pin the
-- welcome's (tenant, recipient_user, recipient_device) triple to a real device of that user.
create unique index if not exists devices_tenant_user_id_uidx on devices (tenant_id, user_id, id);

create table if not exists conversation_welcomes (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  conversation_id     uuid not null,
  -- The new member this welcome is FOR. Fetch is scoped to recipient_user_id = the verified caller.
  recipient_user_id   uuid not null,
  -- The specific recipient DEVICE whose claimed KeyPackage this Welcome is sealed to. In a multi-device
  -- account each device has its own KeyPackages; a welcome sealed to one device is useless to (and must
  -- not be consumed by) the others — so list/consume are scoped to (recipient_user_id, recipient_device_id).
  recipient_device_id uuid not null,
  -- The VERIFIED inviter who delivered it (sub -> user), never client input.
  sender_user_id      uuid not null,
  -- Opaque MLS Welcome + RatchetTree (base64). The server stores + forwards; it never parses/decrypts.
  welcome             text not null,
  ratchet_tree        text not null,
  created_at          timestamptz not null default now(),
  -- The conversation MUST be in this row's tenant. CASCADE — deleting a conversation removes pending welcomes.
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  -- Recipient + sender must be users IN this tenant. NO ACTION (preserve, like messages.sender_user_id);
  -- a TENANT teardown still cascades via tenant_id -> tenants.
  foreign key (tenant_id, recipient_user_id) references users (tenant_id, id) on delete no action,
  -- The recipient device must be a device OWNED BY recipient_user_id in this tenant (rejects an unknown
  -- device, or one belonging to another user — no inconsistent/orphan welcome). NO ACTION like the user FKs.
  foreign key (tenant_id, recipient_user_id, recipient_device_id)
    references devices (tenant_id, user_id, id) on delete no action,
  -- A pending welcome is OWNED BY the recipient's membership: revoking app-level membership (deleting the
  -- conversation_members row) CASCADE-drops the pending join material, so the server never hands a Welcome
  -- to a REMOVED member (mirrors conversation_receipts -> conversation_members). The deliver tx adds the
  -- member before inserting the welcome, so this FK is always satisfiable.
  foreign key (tenant_id, conversation_id, recipient_user_id)
    references conversation_members (tenant_id, conversation_id, user_id) on delete cascade,
  foreign key (tenant_id, sender_user_id) references users (tenant_id, id) on delete no action
);
alter table conversation_welcomes enable row level security;
alter table conversation_welcomes force row level security;
drop policy if exists conversation_welcomes_tenant_isolation on conversation_welcomes;
create policy conversation_welcomes_tenant_isolation on conversation_welcomes
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- "This device's pending welcomes" (fetched on connect) — leading tenant_id, device-scoped.
create index if not exists conversation_welcomes_recipient_idx
  on conversation_welcomes (tenant_id, recipient_user_id, recipient_device_id);
-- Backs the conversation FK cascade + per-conversation cleanup — leading tenant_id.
create index if not exists conversation_welcomes_conversation_idx
  on conversation_welcomes (tenant_id, conversation_id);

-- Welcomes are TRANSIENT (consumed on join), not append-only: the recipient deletes after joining.
grant select, insert, delete on conversation_welcomes to argus_app;
