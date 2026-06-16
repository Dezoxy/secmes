-- 0036_webauthn_atomic_register — atomic passkey registration across tenant boundary.
--
-- Problem: migration 0035 added invite_tenant_id to webauthn_challenges so
-- verifyRegistration could call withTenant(inviteTenantId) for the invite UPDATE
-- before calling withTenant(DEFAULT_TENANT_ID) for user creation.  But splitting
-- the operation into two separate transactions destroys the atomicity guarantee
-- (Codex P1: invite burned even when the following registration fails).
--
-- Solution: a new PERMISSIVE RLS policy on tenant_invites that exposes and allows
-- updating exactly ONE row — the row whose id matches the app.current_invite_id GUC.
-- verifyRegistration sets this GUC inside a single withTenant(DEFAULT_TENANT_ID)
-- transaction so all five operations (challenge delete, invite consume,
-- attestation verify, user insert, credential insert) remain atomic.
--
-- Security: the invite UUID is stored in webauthn_challenges at redeem time (not
-- supplied by the client at verify time), so the GUC-scoped policy cannot be
-- abused to target arbitrary invite rows.

-- Revert the intermediate invite_tenant_id column added in 0035 — no longer needed.
ALTER TABLE webauthn_challenges DROP COLUMN IF EXISTS invite_tenant_id;

-- New PERMISSIVE policy: visible/modifiable only when app.current_invite_id matches.
-- OR-ed with existing policies so it adds access, never removes it.
-- nullif prevents the '' → uuid cast error on pooled connections with reset GUCs.
CREATE POLICY tenant_invites_passkey_consume ON tenant_invites
  FOR ALL
  USING      (id = nullif(current_setting('app.current_invite_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.current_invite_id', true), '')::uuid);
