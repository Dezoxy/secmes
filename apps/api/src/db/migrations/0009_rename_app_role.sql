-- 0009_rename_app_role — the application was renamed secmes → argus; the non-bypass runtime role is
-- renamed to match. Forward-only and idempotent: existing databases created `secmes_app` (0001) with all
-- its grants, and a role rename keeps those grants (they are stored by role OID, not name). On a fresh
-- database this runs right after 0001 created `secmes_app`. The app code (`withTenant` → SET LOCAL ROLE)
-- targets `argus_app`, so this migration must run before the renamed code serves traffic.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'secmes_app')
     and not exists (select 1 from pg_roles where rolname = 'argus_app') then
    alter role secmes_app rename to argus_app;
  end if;
end $$;
