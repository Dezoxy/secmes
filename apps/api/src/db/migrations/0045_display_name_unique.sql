-- Re-introduce case-insensitive per-tenant display name uniqueness (dropped in 0038).
-- Scope: active users only — inactive/suspended users do not reserve names, matching the
-- updateProfile() pre-flight check which filters status = 'active'.
-- Null out later-created duplicates among active users (keep oldest) before adding the index.
UPDATE users
SET display_name = NULL
WHERE status = 'active'
  AND display_name IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (tenant_id, lower(display_name)) id
    FROM users
    WHERE display_name IS NOT NULL AND status = 'active'
    ORDER BY tenant_id, lower(display_name), created_at ASC
  );

CREATE UNIQUE INDEX users_tenant_display_name_idx
  ON users (tenant_id, lower(display_name))
  WHERE display_name IS NOT NULL AND status = 'active';
