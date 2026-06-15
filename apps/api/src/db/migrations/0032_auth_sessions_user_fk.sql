-- 0032_auth_sessions_user_fk — add ON DELETE CASCADE FK from auth_sessions.user_id to users.id.
--
-- Without this, GdprService.deleteAccount removes the users row but leaves orphaned auth_sessions rows
-- that can never match a live user. Cascade ensures sessions are cleaned up automatically on account deletion.

ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
