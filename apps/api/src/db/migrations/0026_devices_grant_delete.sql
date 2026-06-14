-- 0026_devices_grant_delete — grant DELETE on devices to argus_app.
-- Migration 0004_key_directory granted SELECT/INSERT/UPDATE on devices but not DELETE.
-- The withdrawDevice endpoint (B2 legacy migration path) deletes the old device row under
-- withTenant (SET LOCAL ROLE argus_app), which requires DELETE privilege. Without this grant
-- the delete fails with a permission error, leaving the old row and blocking the legacy
-- migration from completing.
GRANT DELETE ON devices TO argus_app;
