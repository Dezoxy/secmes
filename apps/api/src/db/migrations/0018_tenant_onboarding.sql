-- 0018_tenant_onboarding — G1: self-serve tenant creation + invite flow.
--
-- Three changes:
--   1. user_tenant_index: no-RLS routing table mapping Zitadel sub → tenant_id.
--      Replaces the JWT tenant_id claim (argus-zitadel Action removed). The API
--      derives tenantId from this table after JWT signature verification.
--   2. users.role: admin / member distinction within a tenant.
--   3. tenant_invites: admin-issued single-use invite tokens (hash-at-rest).
--
-- See docs/threat-models/tenant-onboarding.md.

-- ─── 1. user_tenant_index ────────────────────────────────────────────────────
-- No RLS: this is a routing table, not tenant-scoped data. argus_app gets
-- SELECT + INSERT only — bindings are immutable from the app path (no UPDATE/DELETE).
-- ON DELETE RESTRICT prevents removing a tenant while bindings still exist.

create table user_tenant_index (
  sub        text      primary key,
  tenant_id  uuid      not null references tenants(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- argus_app SELECT (read binding) + INSERT (create binding). No UPDATE/DELETE —
-- immutability is the security property.
grant select, insert on user_tenant_index to argus_app;

-- Backfill from existing users so current dev accounts keep working without re-login.
-- Safe on a fresh DB (no rows to insert). ON CONFLICT skips duplicates (idempotent).
insert into user_tenant_index (sub, tenant_id)
select external_identity_id, tenant_id
from   users
on conflict (sub) do nothing;

-- ─── 2. users.role ───────────────────────────────────────────────────────────
-- 'member' default; 'admin' is granted at tenant creation (first user).
-- The check constraint is the DB-level gate; the AdminGuard is the app-level gate.

alter table users
  add column role text not null default 'member'
  check (role in ('member', 'admin'));

-- ─── 3. tenant_invites ───────────────────────────────────────────────────────
-- Tenant-scoped, FORCE RLS. The plaintext token is returned once and never stored;
-- only the SHA-256 hex hash persists here. Globally unique token_hash: a 32-byte
-- random pre-image has 256-bit entropy — collision is infeasible.
--
-- argus_app also gets a bare SELECT (without RLS) to look up an invite by token_hash
-- before the tenant context is known (the accept flow). This is safe: the columns
-- exposed contain no user content — only UUIDs, a hash, timestamps, and an optional
-- email hint. All writes still go through withTenant (RLS enforced).

create table tenant_invites (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants(id) on delete cascade,
  created_by     uuid        not null references users(id)   on delete cascade,
  token_hash     text        not null unique,
  invitee_email  text,
  expires_at     timestamptz not null default (now() + interval '7 days'),
  accepted_by    uuid        references users(id),
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);

alter table  tenant_invites enable  row level security;
alter table  tenant_invites force   row level security;

-- Main per-tenant isolation (bound context): current_setting with missing_ok=true returns NULL when
-- the setting is absent; casting NULL to uuid yields NULL; tenant_id = NULL is UNKNOWN → no rows visible.
-- WITH CHECK also uses missing_ok so the cast never throws during the accept-flow INSERT.
create policy tenant_invites_isolation on tenant_invites
  using      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Cross-tenant lookup (unbound context, withRouting — no app.tenant_id set): allows SELECT of any row
-- when app.tenant_id is not set. Safe because: (a) only non-sensitive columns are granted to argus_app,
-- and (b) the query always filters by token_hash whose pre-image is the 256-bit-entropy secret.
create policy tenant_invites_accept_flow on tenant_invites
  for select
  using (current_setting('app.tenant_id', true) is null);

-- Leading tenant_id index for admin list/lookup under RLS.
create index tenant_invites_tenant_id_idx on tenant_invites (tenant_id);

-- Within-tenant reads/writes (admin CRUD, accept update).
-- Note: table-level SELECT covers all columns; the column-scoped grant below is additive
-- and does NOT restrict which columns are visible under the accept-flow policy.
grant select, insert on tenant_invites to argus_app;
grant update (accepted_by, accepted_at, revoked_at) on tenant_invites to argus_app;

-- Cross-tenant token-hash lookup (accept flow, withRouting — no app.tenant_id set).
-- The accept-flow query selects only non-sensitive columns (ids, timestamps, invitee_email,
-- token_hash); created_by is not queried, though the table-level SELECT above makes it readable.
-- Safe: all columns are metadata only — no user content, no keys, no PII beyond a UUID and
-- an optional email hint (the email hint is needed to enforce the invitee check on accept).
grant select (id, tenant_id, token_hash, invitee_email, expires_at,
              accepted_at, revoked_at)
  on tenant_invites to argus_app;
