-- 0037_admin_credentials — Breakglass admin credential table.
-- Phase 3 of the private-messenger redesign (private-messenger-redesign-plan.md:261-286).
-- Threat model: docs/threat-models/breakglass-admin.md.

-- Stores Argon2id-hashed admin password + lockout state. FORCE RLS + leading tenant_id index
-- (invariant #3). Must never become a global no-RLS routing table, even for a single-tenant deployment.
CREATE TABLE admin_credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username        text        NOT NULL,
  password_hash   text        NOT NULL,   -- base64 raw 32-byte Argon2id output (never plaintext)
  salt            text        NOT NULL,   -- base64 16-byte CSPRNG salt
  kdf_params      jsonb       NOT NULL,   -- { m, t, p } — validated against MIN floor on verify
  failed_attempts integer     NOT NULL DEFAULT 0,
  locked_until    timestamptz,            -- NULL = not locked; set to now()+15min after MAX_ATTEMPTS failures
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_credentials FORCE ROW LEVEL SECURITY;

-- Standard tenant isolation — matches auth_sessions_isolation pattern (migration 0031).
-- nullif guard: prevents '' (pooled GUC default) from being cast to uuid and silently matching NULL rows.
CREATE POLICY admin_credentials_isolation ON admin_credentials
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Leading tenant_id index (invariant #3 — every tenant-scoped table has this).
CREATE INDEX admin_credentials_tenant_user_idx ON admin_credentials (tenant_id, user_id);

-- Singleton uniqueness: at most one breakglass credential per username within the tenant.
-- Also acts as the bootstrap idempotency guard (23505 on re-insert = already bootstrapped).
CREATE UNIQUE INDEX admin_credentials_tenant_username_idx ON admin_credentials (tenant_id, username);

GRANT SELECT, INSERT, UPDATE ON admin_credentials TO argus_app;
