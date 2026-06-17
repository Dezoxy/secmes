-- 0039_decommission_enterprise — drop the SSO config table; data-minimisation null-out of all stored
-- email; purge legacy non-argus routing subjects.
-- Phase 6 of the private-messenger redesign (private-messenger-redesign-plan.md:342-359).
-- Threat model: docs/threat-models/phase-6-decommission.md.
--
-- Forward-only, owner-applied. INERT columns are intentionally LEFT in place (a later dedicated
-- migration can drop them once nothing depends on the shape): tenants.plan_tier / member_limit /
-- sso_enabled / plan_set_at / stripe_customer_id / stripe_subscription_id / subscription_status,
-- users.email, users.external_identity_id, tenant_invites.invitee_email.

-- SSO is removed (no per-tenant IdP). The table's RLS policy, indexes, and grants drop with it.
DROP TABLE IF EXISTS tenant_sso_configs;

-- Data minimisation (locked decision: "email dropped entirely"). Email was only ever written by the
-- now-removed OIDC JIT path, so null every stored copy. The columns stay (nullable) for a later drop.
-- The IS NOT NULL guards make this a no-op on a fresh DB.
UPDATE users          SET email         = NULL WHERE email         IS NOT NULL;
UPDATE tenant_invites SET invitee_email = NULL WHERE invitee_email IS NOT NULL;

-- Purge legacy Zitadel routing subjects from the no-RLS routing table. Active users carry an
-- 'argusid:' subject (minted since Phase 1); only inert legacy rows match. A Zitadel token can no
-- longer be verified anyway (Phase 6 PR1 removed the OIDC verify path), so this orphans no live user.
DELETE FROM user_tenant_index WHERE sub NOT LIKE 'argusid:%';
