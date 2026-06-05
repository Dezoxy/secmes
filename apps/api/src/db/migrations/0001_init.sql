-- 0001_init — runtime role + tenants + users with RLS.
-- Applied by the OWNER/superuser (migrations). The app connects (or SET LOCAL ROLE) as
-- the non-bypass argus_app role so RLS is actually enforced.

-- Non-bypass runtime role. NOLOGIN here (the app does SET LOCAL ROLE argus_app so RLS
-- applies even on a superuser connection in dev). Prod grants it LOGIN + a Key Vault
-- password out-of-band.
do $$
begin
  if not exists (select from pg_roles where rolname = 'argus_app') then
    create role argus_app nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;

-- tenants: the tenant ROOT. No tenant_id column — its own id IS the tenant.
create table if not exists tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);
alter table tenants enable row level security;
alter table tenants force row level security;
drop policy if exists tenants_self_isolation on tenants;
create policy tenants_self_isolation on tenants
  using (id = current_setting('app.tenant_id')::uuid)
  with check (id = current_setting('app.tenant_id')::uuid);

-- users: tenant-scoped.
create table if not exists users (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  external_identity_id text not null,
  email                text not null,
  display_name         text,
  status               text not null default 'active',
  created_at           timestamptz not null default now()
);
alter table users enable row level security;
alter table users force row level security;
drop policy if exists users_tenant_isolation on users;
create policy users_tenant_isolation on users
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
create index if not exists users_tenant_idx on users (tenant_id, created_at);
create unique index if not exists users_tenant_external_idx on users (tenant_id, external_identity_id);

-- Runtime role gets DML only (no DDL, no bypass). Each future tenant table must add its own
-- grant here — explicit per-table grants (not ALTER DEFAULT PRIVILEGES) so a new table is
-- unreadable by the app until deliberately exposed (fail-closed, not fail-open).
grant usage on schema public to argus_app;
grant select, insert, update, delete on tenants, users to argus_app;

-- The runtime role must never create objects. (PG15+ already revokes CREATE from PUBLIC by
-- default; explicit here so the guarantee is self-documenting and survives older engines.)
revoke create on schema public from public;
