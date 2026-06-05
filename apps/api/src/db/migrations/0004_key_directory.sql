-- 0004_key_directory — devices + key_packages (roadmap 19). Stores PUBLIC MLS key material only
-- (base64 text, opaque to the crypto-blind server — no private keys, no plaintext). The server binds
-- each KeyPackage to the authenticated uploader; client-side fingerprint verification is the MITM
-- defense (docs/threat-models/key-directory.md). KeyPackages are one-time-use (claimed, never reused).

create table if not exists devices (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  user_id              uuid not null references users(id) on delete cascade,
  signature_public_key text not null, -- base64 MLS signature public key; clients derive the verification fingerprint from it
  created_at           timestamptz not null default now()
);
alter table devices enable row level security;
alter table devices force row level security;
drop policy if exists devices_tenant_isolation on devices;
create policy devices_tenant_isolation on devices
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
create unique index if not exists devices_identity_idx on devices (tenant_id, user_id, signature_public_key);
create index if not exists devices_tenant_user_idx on devices (tenant_id, user_id);

create table if not exists key_packages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  device_id   uuid not null references devices(id) on delete cascade,
  key_package text not null,  -- base64 opaque PUBLIC MLS KeyPackage
  claimed_at  timestamptz,    -- null = available; set = consumed (one-time-use, never reused)
  created_at  timestamptz not null default now()
);
alter table key_packages enable row level security;
alter table key_packages force row level security;
drop policy if exists key_packages_tenant_isolation on key_packages;
create policy key_packages_tenant_isolation on key_packages
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- Partial index: claim the oldest AVAILABLE package for a device cheaply.
create index if not exists key_packages_available_idx
  on key_packages (tenant_id, device_id, created_at)
  where claimed_at is null;

-- Runtime role: insert + select + update (update needed to claim / idempotent re-register). No delete —
-- pool GC of long-claimed packages is a later maintenance/worker job (cf. audit retention).
grant select, insert, update on devices to argus_app;
grant select, insert, update on key_packages to argus_app;
