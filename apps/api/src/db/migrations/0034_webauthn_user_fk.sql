-- 0034_webauthn_user_fk — FK constraint from webauthn_credentials to users with cascade delete.
-- Omitted from 0033 (oversight); required so deleteAccount() cascades credential rows automatically.

ALTER TABLE webauthn_credentials
  ADD CONSTRAINT webauthn_credentials_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
