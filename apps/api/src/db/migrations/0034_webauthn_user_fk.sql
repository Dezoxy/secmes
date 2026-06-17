-- 0034_webauthn_user_fk — FK constraint + DEFAULT_TENANT_ID unlimited members.
-- Both omitted from 0033 (oversight).

-- Cascade credential rows when a user is deleted (required so deleteAccount() cascades).
ALTER TABLE webauthn_credentials
  ADD CONSTRAINT webauthn_credentials_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

-- DEFAULT_TENANT_ID is a system tenant, not a customer workspace. Remove the default
-- member_limit=10 (from 0022) so passkey registrations are never blocked with a billing error.
UPDATE tenants
SET member_limit = NULL
WHERE id = '00000000-0000-0000-0000-000000000001';
