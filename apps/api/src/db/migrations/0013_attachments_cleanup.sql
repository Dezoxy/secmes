-- 0013_attachments_cleanup — Phase-4 lifecycle (checkpoint 37). A dedicated, least-privilege role for the
-- standalone VM cleanup worker that reaps EXPIRED attachment blobs + rows after the 7-day retention window.
--
-- The problem: `attachments` is FORCE-RLS tenant-isolated on `app.tenant_id`, so the app role (argus_app)
-- only ever sees ONE tenant. The cleanup worker must sweep EXPIRED rows across ALL tenants — but it must
-- NEVER see a live (unexpired) row, and never any other tenant data. We solve this purely in RLS: a
-- separate role with its own policy that exposes ONLY rows whose retention has lapsed.

-- Dedicated cleanup role. NOLOGIN here (tests assume it via SET ROLE, like argus_app); PROD grants it
-- LOGIN + a Key Vault password out-of-band. No bypass, no inherit, no superuser.
do $$
begin
  if not exists (select from pg_roles where rolname = 'argus_cleanup') then
    create role argus_cleanup nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;

-- Restrict the tenant-isolation policy TO argus_app. It reads `app.tenant_id` (which the cleanup worker
-- never sets — an unset GUC makes current_setting() THROW, which would error the worker's query even though
-- RLS policies are OR-combined). The app ALWAYS runs as argus_app (SET LOCAL ROLE); the owner bypasses RLS.
-- So scoping this policy to argus_app is transparent for the app and keeps it from applying to argus_cleanup.
drop policy if exists attachments_tenant_isolation on attachments;
create policy attachments_tenant_isolation on attachments
  to argus_app
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
-- NOTE: `attachments` is the ONLY tenant table whose isolation policy is role-scoped (peers are PUBLIC).
-- Any FUTURE non-bypass role that must READ attachments MUST be added to a policy here explicitly — else it
-- is denied all attachment access (no applicable permissive policy → deny). That fails CLOSED (the safe way).

-- The cleanup role sees + deletes ONLY rows whose retention has lapsed — across tenants, but NEVER a live
-- row and NEVER any other column path. SELECT (list what to reap, with the tenant-prefixed object_key) and
-- DELETE (remove the row after its blob is gone) only — no INSERT/UPDATE policy and no such grant.
drop policy if exists attachments_cleanup_select on attachments;
create policy attachments_cleanup_select on attachments
  for select
  to argus_cleanup
  using (expires_at is not null and expires_at < now());
drop policy if exists attachments_cleanup_delete on attachments;
create policy attachments_cleanup_delete on attachments
  for delete
  to argus_cleanup
  using (expires_at is not null and expires_at < now());

-- DML grants: SELECT + DELETE only (no insert/update — the worker only reaps). The existing
-- attachments_tenant_expiry_idx (tenant_id, expires_at) backs the per-tenant expiry scan; the cleanup
-- worker's cross-tenant scan reads the same column (a partial/expiry index could be added later if needed).
grant usage on schema public to argus_cleanup;
grant select, delete on attachments to argus_cleanup;
