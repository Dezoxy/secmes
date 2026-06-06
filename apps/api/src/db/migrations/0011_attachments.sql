-- 0011_attachments — Phase-4 encrypted image attachments (checkpoint 35). METADATA + CIPHERTEXT REFS
-- ONLY. The image is encrypted client-side under a per-attachment content key; the opaque ciphertext
-- lives in a PRIVATE blob container and the content key lives only inside the MLS message envelope.
-- The server stores NEITHER the bytes, NOR the content key, NOR a plaintext content-type — just the
-- blob handle (object_key) + size + who/when, so it can broker presigned URLs and run lifecycle/cleanup.
-- RLS (ENABLE+FORCE+WITH CHECK) on app.tenant_id isolates tenants; composite FK pins the uploader to the
-- row tenant. See docs/threat-models/encrypted-attachments.md. Member-only access authz is the app layer.
create table if not exists attachments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- Server-chosen, tenant-prefixed handle to the ciphertext blob (e.g. "<tenant_id>/<uuid>"). NOT a URL
  -- (presigned URLs are capabilities — never persisted/logged, invariant #2); just the object key.
  object_key  text not null,
  -- Size of the OPAQUE ciphertext blob (bytes). Intrinsic object-storage metadata; not content.
  byte_size   bigint not null check (byte_size > 0),
  -- The VERIFIED caller who created the upload grant (sub -> user), never client input.
  uploaded_by uuid not null,
  created_at  timestamptz not null default now(),
  -- Lifecycle: when the blob may be pruned (set by the app/cleanup worker, checkpoint 37). Nullable.
  expires_at  timestamptz,
  -- One row per blob; also the leading-tenant_id lookup path (object_key resolved within the tenant).
  unique (tenant_id, object_key),
  -- Composite FK pins the uploader to THIS row's tenant (defence-in-depth beneath RLS): an attachment
  -- can't reference a user in another tenant. NO ACTION (not cascade): deleting a USER must NOT erase
  -- their attachment history through a parent delete (like messages.sender_user_id). Blocks a direct
  -- user delete that would orphan attachments; a TENANT teardown still cascades (tenant_id -> tenants).
  foreign key (tenant_id, uploaded_by) references users (tenant_id, id) on delete no action
);
alter table attachments enable row level security;
alter table attachments force row level security;
drop policy if exists attachments_tenant_isolation on attachments;
create policy attachments_tenant_isolation on attachments
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- "Which attachments expire before T?" for the cleanup worker — leading tenant_id.
create index if not exists attachments_tenant_expiry_idx on attachments (tenant_id, expires_at);

-- Attachments are PRUNABLE metadata (unlike append-only messages): the lifecycle/cleanup worker (37)
-- deletes expired rows after removing their blobs. Role is argus_app (renamed from secmes_app by 0009).
grant select, insert, delete on attachments to argus_app;
