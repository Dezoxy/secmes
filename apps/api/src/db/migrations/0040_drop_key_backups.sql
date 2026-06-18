-- Remove the passphrase-sealed key-backup surface (no recoverable secret on the server).
-- The table was created by 0006_key_backups.sql; CASCADE drops the RLS policy and index with it.
DROP TABLE IF EXISTS key_backups CASCADE;
