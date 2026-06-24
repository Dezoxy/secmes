-- Re-introduce case-insensitive per-tenant display name uniqueness (dropped in 0038).
-- Keep the oldest registration per (tenant_id, lower(display_name)); null out later duplicates.
UPDATE users u
SET display_name = NULL
WHERE display_name IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (tenant_id, lower(display_name)) id
    FROM users
    WHERE display_name IS NOT NULL
    ORDER BY tenant_id, lower(display_name), created_at ASC
  );

CREATE UNIQUE INDEX users_tenant_display_name_idx
  ON users (tenant_id, lower(display_name))
  WHERE display_name IS NOT NULL;
