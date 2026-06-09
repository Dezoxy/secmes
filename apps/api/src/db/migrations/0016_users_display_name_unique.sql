-- Roadmap #44b: pseudonymous handles. Enforce ONE display_name per tenant so the server-generated
-- "Adjective Animal" handles cannot collide (no two users in a tenant share a handle).
--
-- Pre-#44b rows took display_name from the IdP `name` claim — a REAL name. #44b makes the display identity
-- pseudonymous, so this migration NULLs EVERY existing display_name. That does two things at once:
--   1. removes any lingering real name (a unique legacy name would otherwise persist via the coalesce in
--      provisionFromToken and keep leaking through GET /users), and
--   2. lets the unique index build even where legacy names duplicated within a tenant (NULLs are DISTINCT).
-- Each user is then healed to a fresh generated handle on their next login (provisionFromToken coalesces a
-- NULL display_name to a new handle). New users are unique by construction. Runs on the migrate owner
-- connection (RLS-bypassing), so it spans all tenants. See docs/threat-models/pseudonymous-identity.md.
update users set display_name = null;

-- display_name stays NULLABLE; (tenant_id, display_name) is tenant-scoped, consistent with FORCE RLS.
create unique index if not exists users_tenant_display_name_idx
  on users (tenant_id, display_name);
