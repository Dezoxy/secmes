-- 0045_user_privacy_settings — per-user privacy preference columns (read receipts,
-- typing indicators, link previews). Stored on the users row so the existing
-- users_tenant_isolation RLS policy and argus_app grants cover them automatically —
-- no new table, no new RLS policy, no new grants.
--
-- NULL means "use the server default" (true for all three). The application layer
-- coerces NULL → true before returning the value to clients.
--
-- No index: these columns are never filtered on; they are read only per-user via the
-- existing (id, tenant_id) predicate that uses the PK.
--
-- See docs/threat-models/privacy-settings.md.

ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_read_receipts    boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_typing_indicators boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_link_previews    boolean;
