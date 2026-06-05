-- 0006_key_backups — the server stores each user's passphrase-SEALED backup blob, CIPHERTEXT ONLY.
-- The blob is opaque (Argon2id + AES-256-GCM, sealed client-side); the server has no passphrase and
-- cannot open it. One current backup per user — rotation replaces it.
create table if not exists key_backups (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  backup     text not null, -- opaque sealed backup; the server never parses or inspects it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table key_backups enable row level security;
alter table key_backups force row level security;
drop policy if exists key_backups_tenant_isolation on key_backups;
create policy key_backups_tenant_isolation on key_backups
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
create unique index if not exists key_backups_user_idx on key_backups (tenant_id, user_id);

-- Upsert (store/replace) + select (restore). No delete — rotation overwrites the row.
grant select, insert, update on key_backups to argus_app;
