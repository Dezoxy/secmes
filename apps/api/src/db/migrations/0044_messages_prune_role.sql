-- 0044_messages_prune_role — Track 4 slice 3 (message-retention boundary). NO new table, NO deletion,
-- NO worker. This builds and proves the deletion AUTHORITY before any worker can delete: a dedicated,
-- least-privilege role (argus_msg_prune) plus the time-windowed RLS policies + column-scoped grants that
-- confine it to ONLY rows past the 90-day ceiling, metadata-only (never ciphertext). It also closes the
-- #262 OR-combine bypass for `messages` (re-scope the isolation policy TO argus_app, same migration that
-- first grants the prune role a policy). The TTL worker that actually reaps is slice 4; conversation_commits
-- is slice 5. See docs/threat-models/message-retention.md (§3 #262 + history-fork, §7 conditions 1-2).
--
-- Design (mirrors 0043_audit_prune_role for audit_events/auth_sessions): argus_msg_prune is cross-tenant
-- but, by RLS, can ONLY ever see/delete rows past their window — never a live row, never the ciphertext
-- column. The window is DATABASE-enforced (a policy predicate), not merely a worker WHERE clause: a
-- buggy/omitted predicate, or a leaked credential, still cannot touch an in-window row or read content.
-- Fail-closed beats trust-the-query. No BYPASSRLS; dedicated role (not the shared argus_prune) so the
-- #262 surface stays auditable per table (threat model §7 cond 2).

-- 1. Dedicated prune role. NOLOGIN here (the RLS spec assumes it via SET ROLE, like argus_app/argus_prune);
--    slice 4's deploy.sh grants it LOGIN with a NULL password out-of-band (in-container local-trust socket
--    only, no published port, no secret). No bypass, no inherit, no superuser.
do $$
begin
  if not exists (select from pg_roles where rolname = 'argus_msg_prune') then
    create role argus_msg_prune nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;
grant usage on schema public to argus_msg_prune;

-- 2. messages. Re-scope the tenant-isolation policy TO argus_app. REQUIRED, not cosmetic: 0007 wrote it
--    PUBLIC with the no-missing_ok current_setting form, which THROWS (not "no rows") when app.tenant_id is
--    unset — exactly argus_msg_prune's normal state. A PUBLIC throwing policy would error every prune query
--    even though policies are OR-combined. Worse, being PUBLIC it applies to argus_msg_prune, which CAN
--    issue set_config('app.tenant_id', <victim>): the isolation USING would then become TRUE for that
--    tenant's rows and OR with the past-window prune policy below → the prune role could SELECT/DELETE that
--    tenant's LIVE ciphertext, defeating the retention-only boundary. Scoping it TO argus_app removes it
--    from argus_msg_prune entirely (its ONLY applicable policies become the past-window prune policies, so
--    setting app.tenant_id buys nothing) and is transparent for the app (it ALWAYS runs as argus_app with
--    the GUC set). Same fix 0043 applied to audit_events and 0013 to attachments.
drop policy if exists messages_tenant_isolation on messages;
create policy messages_tenant_isolation on messages
  to argus_app
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- 3. Prune policies: argus_msg_prune sees + deletes ONLY rows past the 90-day ceiling — across tenants, but
--    never an in-window row. SELECT is needed for the worker's batched `delete ... where id in (select ...)`
--    and its affected-row count. No INSERT/UPDATE policy or grant for argus_msg_prune (it only reaps).
drop policy if exists messages_prune_select on messages;
create policy messages_prune_select on messages
  for select
  to argus_msg_prune
  using (created_at < now() - interval '90 days');
drop policy if exists messages_prune_delete on messages;
create policy messages_prune_delete on messages
  for delete
  to argus_msg_prune
  using (created_at < now() - interval '90 days');

-- Column-scoped SELECT (mirrors argus_prune's grant in 0043): the worker reads ONLY id + created_at (the
-- batch subselect + its WHERE, and the columns the DELETE policy's USING reads). A leaked/misused prune
-- credential can NEVER read `ciphertext` or any routing metadata even of a past-window row — invariant #1,
-- the crypto-blind server. DELETE stays table-level (still RLS-gated to the past-window rows by the policy
-- above). 90 days is the single reviewed ceiling: it lives in the policy literal (the actual enforcement
-- boundary); slice 4's worker must pass a matching interval, and even if it drifts the DELETE policy is the
-- hard floor — the worker can never delete a newer row.
grant select (id, created_at), delete on messages to argus_msg_prune;

-- 4. Prune-oriented index. The prune scans cross-tenant and age-ordered with NO tenant_id predicate
--    (`where created_at < cutoff order by created_at limit N`). The existing messages indexes are all
--    tenant-LEADING (messages_conversation_idx is (tenant_id, conversation_id, created_at)) so none can
--    serve that scan — on a large historical backlog each batch would seq-scan + sort. A plain created_at
--    btree backs the range scan + ordering directly. created_at is ~monotonic, so inserts append to the
--    right of the btree (no bloat, negligible write cost). Mirrors 0043's audit_events_created_at_idx.
create index if not exists messages_created_at_idx on messages (created_at);
