-- 0020_gdpr_account_deletion — schema + permission changes required for GDPR Art. 17 erasure.

-- 1. Allow sender_user_id to be NULL on messages for GDPR erasure.
--    When a user deletes their account, sent message rows are pseudonymized (sender_user_id → NULL)
--    rather than deleted so offline recipients can still fetch ciphertext they are entitled to.
--    The content is MLS ciphertext opaque to the server; a NULL sender only means "account erased".
alter table messages alter column sender_user_id drop not null;

-- 2. Grant UPDATE on sender_user_id to secmes_app.
--    messages was intentionally append-only (no UPDATE grant) but erasure requires pseudonymizing
--    the sender column. A column-level grant limits the blast radius: only sender_user_id can be
--    updated via the app role, not ciphertext or any other message column.
grant update (sender_user_id) on messages to secmes_app;

-- 3. Allow conversations.created_by to be NULL for GDPR erasure.
--    The NO ACTION FK prevents deleting a user who created conversations. Nullifying created_by
--    before the user row is deleted satisfies the FK constraint without destroying the conversation
--    or other members' ciphertext. A NULL created_by means "created by an account that was erased".
alter table conversations alter column created_by drop not null;

-- Grant UPDATE on created_by to secmes_app so the erasure path can null it out.
-- Column-level grant limits scope: only created_by can be updated, not other columns.
grant update (created_by) on conversations to secmes_app;

-- 4. Grant DELETE on user_tenant_index to argus_app for erasure cleanup.
--    The routing table previously had no DELETE grant (bindings were considered permanent).
--    GDPR erasure requires removing the sub→tenant binding so the erased identity cannot be
--    accidentally re-routed after account deletion. The grant is scoped to DELETE only.
grant delete on user_tenant_index to argus_app;
