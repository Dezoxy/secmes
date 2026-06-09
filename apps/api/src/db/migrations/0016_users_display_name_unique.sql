-- Roadmap #44b: pseudonymous handles. Enforce ONE display_name per tenant so the server-generated
-- "Adjective Animal" handles cannot collide (no two users in a tenant share a handle).
--
-- Pre-#44b rows took display_name from the IdP `name` claim, which CAN repeat within a tenant (two "John
-- Smith"s). A plain unique index would abort on such duplicates, so first de-duplicate: NULL out all but the
-- earliest row of each duplicate (tenant_id, display_name) group. A standard unique index treats NULLs as
-- DISTINCT, so the index then builds, and those NULLed users are healed to a fresh generated handle on their
-- next login (UserService.provisionFromToken coalesces a NULL display_name to a new handle). New users are
-- unique by construction. Runs on the migrate owner connection (RLS-bypassing), so it spans all tenants.
-- See docs/threat-models/pseudonymous-identity.md.
update users
set display_name = null
where id in (
  select id
  from (
    select
      id,
      row_number() over (partition by tenant_id, display_name order by created_at, id) as rn
    from users
    where display_name is not null
  ) ranked
  where ranked.rn > 1
);

-- display_name stays NULLABLE; (tenant_id, display_name) is tenant-scoped, consistent with FORCE RLS.
create unique index if not exists users_tenant_display_name_idx
  on users (tenant_id, display_name);
