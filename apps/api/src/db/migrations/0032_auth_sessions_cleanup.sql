-- Prune expired auth_sessions rows to prevent unbounded table growth.
-- Deleting rows where expires_at < now() - '30 days'::interval is safe: any active rotation
-- chain would have minted a fresh row well before expiry, so the old row is only reuse-detection
-- history. 30 days of post-expiry retention covers the full session window as a forensics buffer.
-- Suggested periodic job (pg_cron or external cron):
--   DELETE FROM auth_sessions WHERE expires_at < now() - '30 days'::interval;
GRANT DELETE ON auth_sessions TO argus_app;
