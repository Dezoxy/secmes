-- Roadmap #44b: pseudonymous handles. Enforce ONE display_name per tenant so the server-generated
-- "Adjective Animal" handles cannot collide (no two users in a tenant share a handle).
--
-- display_name stays NULLABLE on purpose: a standard unique index treats NULLs as DISTINCT, so legacy rows
-- provisioned before #44b (an IdP-derived name, or NULL) are unaffected and the migration can't fail on them.
-- New users always get a non-null unique handle; UserService.provisionFromToken regenerates on a 23505 against
-- this index. The index is (tenant_id, display_name) — tenant-scoped, consistent with FORCE RLS on the table.
-- See docs/threat-models/pseudonymous-identity.md.
create unique index if not exists users_tenant_display_name_idx
  on users (tenant_id, display_name);
