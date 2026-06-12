-- 0020_gdpr_account_deletion — allow sender_user_id to be NULL on messages for GDPR erasure.
-- When a user deletes their account, sent message rows are pseudonymized (sender_user_id → NULL)
-- rather than deleted so offline recipients can still fetch ciphertext they are entitled to.
-- The content is MLS ciphertext opaque to the server; a NULL sender only means "account erased".
alter table messages alter column sender_user_id drop not null;
