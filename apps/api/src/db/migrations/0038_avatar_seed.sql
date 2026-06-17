-- Phase 4: add avatar_seed; drop display_name unique constraint (names are now free nicknames).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed text;
DROP INDEX IF EXISTS users_tenant_display_name_idx;
