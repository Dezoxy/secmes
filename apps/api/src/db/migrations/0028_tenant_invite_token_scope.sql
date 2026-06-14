-- 0028_tenant_invite_token_scope — harden the tenant_invites accept-flow RLS carve-out (audit finding arch-3).
--
-- Context: migration 0018 added `tenant_invites_accept_flow`, a SELECT policy that exposed EVERY row of
-- tenant_invites whenever app.tenant_id was unset (the invite-accept lookup runs under withRouting with no
-- tenant context). Safety rested ENTIRELY on the application always filtering by token_hash — RLS no longer
-- backstopped an app bug, so a future/regressed unfiltered SELECT under withRouting would leak other tenants'
-- invitee_email + invite metadata.
--
-- Two changes, both keeping the legitimate accept-flow working while removing the bulk-read exposure:
--
-- 1. Scope the accept-flow carve-out to a SINGLE row. The accept flow now sets a transaction-local
--    `app.invite_token_hash` GUC (mirroring how withTenant sets app.tenant_id); the policy exposes only the
--    row whose token_hash matches it. Unset GUC → current_setting returns NULL → token_hash = NULL is UNKNOWN
--    → no row. An unfiltered cross-tenant SELECT is now structurally impossible; RLS backstops the app again.
--
-- 2. Make the bound-context isolation cast EMPTY-safe. current_setting('app.tenant_id', true) returns ''
--    (the empty string), NOT NULL, on a pooled connection that previously ran a withTenant() transaction
--    (a transaction-local GUC reverts to its placeholder default ''). ''::uuid throws "invalid input syntax
--    for type uuid", which aborts the unbound invite-accept lookup on any reused connection — a latent flaky
--    failure. nullif(current_setting(...), '') maps both unset (NULL) and reset ('') to NULL, so the cast
--    never throws and the policy fails closed gracefully (no rows) instead of erroring. This completes the
--    no-throw intent the 0018 comment described ("missing_ok so the cast never throws") for the '' case, and
--    is scoped to tenant_invites only — other tenant tables intentionally fail closed loudly (no unbound read).
--
-- Chosen over a SECURITY DEFINER lookup function: under FORCE ROW LEVEL SECURITY a definer function only
-- bypasses RLS when its owner holds BYPASSRLS (environment-dependent; would silently return zero rows where
-- the migration role is not a superuser). The GUC-scoped policy reuses the existing app.tenant_id idiom.
--
-- See docs/threat-models/tenant-onboarding.md and rls-tenant-isolation.md.

alter policy tenant_invites_isolation on tenant_invites
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- missing_ok=true: an unset app.invite_token_hash yields NULL → matches no row (fail closed), never throws.
alter policy tenant_invites_accept_flow on tenant_invites
  using (token_hash = current_setting('app.invite_token_hash', true));
