-- 0035_webauthn_invite_tenant — add invite_tenant_id to webauthn_challenges.
--
-- verifyRegistration must consume the invite under the tenant that issued it (RLS
-- on tenant_invites requires tenant_id = app.tenant_id).  The issuing tenant is not
-- always DEFAULT_TENANT_ID — admins on any tenant may issue passkey invite codes via
-- POST /tenants/invites.  Storing the issuing tenant ID in the challenge row at redeem
-- time lets verifyRegistration call withTenant(inviteTenantId) for the invite UPDATE
-- instead of running it under DEFAULT_TENANT_ID where the row is invisible.
--
-- Nullable: existing in-flight challenges lack this value and will be rejected at
-- verifyRegistration (they were short-lived 5-min rows; a fresh redeem picks up the
-- column automatically).

ALTER TABLE webauthn_challenges ADD COLUMN invite_tenant_id uuid;
