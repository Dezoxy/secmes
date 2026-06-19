-- 0043_audit_prune_role — F1/AR-1 + ER-1 remediation (review finding, beta-blocker).
--
-- This migration adds NO new table. It creates a dedicated, least-privilege maintenance role
-- (argus_prune) and the time-windowed RLS policies + grants that let an out-of-band systemd-timer
-- worker enforce the retention windows the schema has only ever *promised* in prose:
--   • audit_events — 90-day prune (the comment at 0002:22-23; attested in article-30-records.md).
--   • auth_sessions — 30-day-post-expiry prune (the window documented in 0032's comment; 0032 granted DELETE
--     to argus_app for a suggested cron — this migration introduces the dedicated argus_prune grant instead).
-- It also adds the column-scoped UPDATE grant the GDPR Art. 17 erasure flow needs for ER-1.
--
-- Design (see docs/threat-models/audit-logging.md): argus_prune is cross-tenant but, by RLS policy,
-- can ONLY ever see/delete rows past their retention window — never a live row, never any other
-- column path. The time window is DATABASE-enforced (a policy predicate), not merely a WHERE clause
-- in the worker: a buggy/omitted predicate, or a leaked argus_prune credential, still cannot touch an
-- in-window row. Fail-closed beats trust-the-query. No BYPASSRLS (unlike argus_backup, which needs it
-- for full dumps); this mirrors argus_cleanup (0013), scoped to a different pair of tables.

-- 1. Dedicated prune role. NOLOGIN here (tests assume it via SET ROLE, like argus_app/argus_cleanup);
--    deploy.sh grants it LOGIN with a NULL password out-of-band (in-container local-trust socket only,
--    no published port, no secret). No bypass, no inherit, no superuser.
do $$
begin
  if not exists (select from pg_roles where rolname = 'argus_prune') then
    create role argus_prune nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;
grant usage on schema public to argus_prune;

-- 2. audit_events. Re-scope the tenant-isolation policy TO argus_app. REQUIRED, not cosmetic: 0002
--    wrote it PUBLIC with the no-missing_ok current_setting form, which THROWS (not "no rows") when
--    app.tenant_id is unset — exactly argus_prune's state. A PUBLIC throwing policy would error every
--    argus_prune query even though policies are OR-combined. Scoping it to argus_app is transparent for
--    the app (it ALWAYS runs as argus_app with the GUC set) and keeps it from applying to argus_prune.
--    Same fix 0013 applied to attachments.
drop policy if exists audit_events_tenant_isolation on audit_events;
create policy audit_events_tenant_isolation on audit_events
  to argus_app
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Prune policies: argus_prune sees + deletes ONLY rows past the 90-day window — across tenants, but
-- never an in-window row. SELECT is needed for the worker's batched `delete ... where id in (select ...)`
-- and its affected-row count. No INSERT/UPDATE policy or grant for argus_prune (it only reaps).
drop policy if exists audit_events_prune_select on audit_events;
create policy audit_events_prune_select on audit_events
  for select
  to argus_prune
  using (created_at < now() - interval '90 days');
drop policy if exists audit_events_prune_delete on audit_events;
create policy audit_events_prune_delete on audit_events
  for delete
  to argus_prune
  using (created_at < now() - interval '90 days');

-- Column-scoped SELECT (mirrors argus_cleanup's grant in 0013): the worker reads only id + created_at (the
-- batch subselect + its WHERE); a leaked/misused prune credential can't read actor_sub, ip, or metadata even
-- of a past-window row. DELETE stays table-level (still RLS-gated to the 90-day window by the policy above).
grant select (id, created_at), delete on audit_events to argus_prune;

-- 3. auth_sessions. NO re-scope of auth_sessions_isolation here: unlike audit_events, 0031 wrote it with
--    the nullif(current_setting('app.tenant_id', true), '') missing_ok form, which for argus_prune
--    returns NULL → `tenant_id = NULL` is UNKNOWN → no rows (fail-closed, never throws). So the PUBLIC
--    isolation policy is harmless to argus_prune and we leave it untouched (tighter diff, no risk to the
--    auth path). The PUBLIC auth_sessions_refresh_lookup carve-out is likewise inert for argus_prune
--    (gated on app.session_refresh_hash, which the worker never sets). argus_prune's effective visibility
--    is therefore exactly the expired-window rows below.
drop policy if exists auth_sessions_prune_select on auth_sessions;
create policy auth_sessions_prune_select on auth_sessions
  for select
  to argus_prune
  using (expires_at < now() - interval '30 days');
drop policy if exists auth_sessions_prune_delete on auth_sessions;
create policy auth_sessions_prune_delete on auth_sessions
  for delete
  to argus_prune
  using (expires_at < now() - interval '30 days');

-- Column-scoped SELECT: the worker reads only id + expires_at, so the prune credential can't read
-- refresh_token_hash or sub even of an expired row. DELETE stays table-level (RLS-gated to the 30-day window).
grant select (id, expires_at), delete on auth_sessions to argus_prune;

-- 3b. Prune-oriented indexes. The prune scans cross-tenant and age-ordered with NO tenant_id predicate
--     (`where created_at < cutoff order by created_at limit N`, same for expires_at). The existing
--     audit_events index is tenant-LEADING (`tenant_id, created_at desc`) so it can't serve that scan, and
--     auth_sessions has no expires_at index at all — so on a large historical backlog each batch would
--     seq-scan + sort the table, risking a daily-unit timeout / heavy read pressure instead of cheap
--     retention. These plain btree indexes back the range scan + ordering directly. created_at/expires_at are
--     ~monotonic, so inserts append to the right of the btree (no bloat, negligible write cost).
create index if not exists audit_events_created_at_idx on audit_events (created_at);
create index if not exists auth_sessions_expires_at_idx on auth_sessions (expires_at);

-- 4. ER-1: column-scoped UPDATE grant for GDPR Art. 17 erasure.
--    The erasure flow (gdpr.service.ts) deletes audit rows where the erased user was the ACTOR, but a
--    lookup/friend-request row where they were the TARGET keeps metadata.targetArgusId = their argus-id
--    with a DIFFERENT actor — so it survived erasure (ER-1). Deleting that row would destroy another
--    user's legitimate audit history; instead we scrub just the target identifier in place
--    (metadata - 'targetArgusId'). That needs UPDATE on audit_events, which the append-only design
--    (0002: select+insert only; 0021 added delete) deliberately withheld.
--    This grant is COLUMN-SCOPED to `metadata` ONLY: the app still cannot rewrite event_type, actor_sub,
--    ip, or created_at — the integrity fields that prove who-did-what. Scrubbing a target identifier
--    under an erasure obligation is the opposite of a cover-up. Documented + GDPR-owner-cleared in
--    docs/threat-models/audit-logging.md; the append-only negative test now asserts exactly this boundary
--    (metadata UPDATE allowed; integrity-column UPDATE still denied).
grant update (metadata) on audit_events to argus_app;
