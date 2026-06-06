-- 0011_attachments — Phase-4 encrypted image attachments (checkpoint 35). METADATA + CIPHERTEXT REFS
-- ONLY. The image is encrypted client-side under a per-attachment content key; the opaque ciphertext
-- lives in a PRIVATE blob container and the content key lives only inside the MLS message envelope.
-- The server stores NEITHER the bytes, NOR the content key, NOR a plaintext content-type — just the
-- blob handle (object_key) + owning conversation + size + who/when, so it can broker presigned URLs and
-- run lifecycle/cleanup. RLS (ENABLE+FORCE+WITH CHECK) on app.tenant_id isolates tenants; composite FKs
-- pin BOTH the conversation and the uploader to the row tenant. See encrypted-attachments.md.
--
-- AUTHZ BINDING (security-critical): `conversation_id` is the SERVER-OWNED owning conversation, recorded
-- at upload time from the uploader's VERIFIED membership. Download authz is checked against THIS row's
-- conversation_id — never against a client-supplied message `attachmentObjectKey` (the send path accepts
-- any non-URL key, so trusting a message ref would let a same-tenant user echo another blob's key into a
-- conversation they control and mint a URL for the wrong blob — a confused-deputy/IDOR). The app layer
-- enforces: POST grant requires membership of conversation_id; GET download authorizes from this row.
create table if not exists attachments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- The owning conversation (server-verified at upload). Drives member-only download authz.
  conversation_id uuid not null,
  -- Server-chosen handle to the ciphertext blob (e.g. "<tenant_id>/<uuid>"). NOT a URL (presigned URLs
  -- are capabilities — never persisted/logged, invariant #2); just the object key. The CHECK forces the
  -- key to be prefixed with THIS row's tenant_id so it is structurally tenant-bound — the blob store is
  -- OUTSIDE Postgres RLS, so the app's prefixing must fail closed at the schema (see the global unique).
  object_key      text not null check (object_key like tenant_id::text || '/%'),
  -- Size of the OPAQUE ciphertext blob (bytes). Intrinsic object-storage metadata; not content.
  byte_size       bigint not null check (byte_size > 0),
  -- The VERIFIED caller who created the upload grant (sub -> user), never client input.
  uploaded_by     uuid not null,
  created_at      timestamptz not null default now(),
  -- Lifecycle: when the blob may be pruned (set by the app/cleanup worker, checkpoint 37). Nullable.
  expires_at      timestamptz,
  -- GLOBALLY unique: the blob container is outside Postgres RLS, so a per-tenant-unique key would let
  -- two tenants' rows point at the same blob (tenant B minting a SAS URL for tenant A's object via its
  -- own RLS-visible row). Global unique + the tenant-prefix CHECK make cross-tenant blob aliasing
  -- impossible. Tenant-scoped access paths are served by the (tenant_id, ...) indexes below.
  unique (object_key),
  -- Composite FK: the attachment's conversation MUST be in this row's tenant. CASCADE — deleting a
  -- conversation removes its attachment rows (like messages); the blobs are reaped by the cleanup worker.
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, id) on delete cascade,
  -- Composite FK pins the uploader to this row's tenant. NO ACTION (not cascade): deleting a USER must
  -- NOT erase their attachment history through a parent delete (like messages.sender_user_id). Blocks a
  -- direct user delete that would orphan attachments; a TENANT teardown still cascades (tenant_id->tenants).
  foreign key (tenant_id, uploaded_by) references users (tenant_id, id) on delete no action
);
alter table attachments enable row level security;
alter table attachments force row level security;
drop policy if exists attachments_tenant_isolation on attachments;
create policy attachments_tenant_isolation on attachments
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- "Attachments in this conversation" (download authz + listing) — leading tenant_id; backs the FK cascade.
create index if not exists attachments_tenant_conversation_idx on attachments (tenant_id, conversation_id);
-- "Which attachments expire before T?" for the cleanup worker — leading tenant_id.
create index if not exists attachments_tenant_expiry_idx on attachments (tenant_id, expires_at);

-- Attachments are PRUNABLE metadata (unlike append-only messages): the lifecycle/cleanup worker (37)
-- deletes expired rows after removing their blobs. Role is argus_app (renamed from secmes_app by 0009).
grant select, insert, delete on attachments to argus_app;
