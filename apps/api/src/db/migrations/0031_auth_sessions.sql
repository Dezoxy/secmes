-- 0031_auth_sessions — introduce the auth_sessions table for self-minted session tokens (Phase 1).
--
-- Access tokens are stateless EdDSA JWTs (10-min TTL, verified by the API's own public key).
-- Refresh tokens are single-use, 256-bit CSPRNG values stored as SHA-256 hashes here.
--
-- RLS design mirrors auth_sessions:
-- • auth_sessions_isolation (bound context): standard tenant_id policy, nullif guard (see 0028).
-- • auth_sessions_refresh_lookup (pre-tenant carve-out): mirrors tenant_invites_accept_flow (0028).
--   The refresh endpoint has no bearer token — it presents only the HttpOnly refresh cookie.
--   We set app.session_refresh_hash GUC transaction-locally; the policy exposes only the matching row.
--   Unset GUC → current_setting returns NULL → refresh_token_hash = NULL is UNKNOWN → no rows.
--   The tenant_id read from this row is then used for withTenant() — it is server-derived, not
--   client-supplied. See docs/threat-models/session-tokens.md §guc-carve-out.

CREATE TABLE auth_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  user_id            uuid        NOT NULL,
  sub                text        NOT NULL,  -- argusid:<argus_id>; stored for access-token re-mint
  refresh_token_hash text        NOT NULL,  -- SHA-256 hex of 32-byte CSPRNG token (never stored plain)
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,  -- 30-day absolute expiry from creation
  revoked_at         timestamptz           -- NULL = active; set on logout or rotation
);

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

-- Bound-context isolation: nullif handles '' → NULL on pooled connections (GUC reverts to '' on txn end).
CREATE POLICY auth_sessions_isolation ON auth_sessions
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Pre-tenant refresh lookup (permissive SELECT only, mirrors tenant_invites_accept_flow from 0028).
-- missing_ok=true (second arg): unset GUC → NULL → matches no row (fail closed), never throws.
CREATE POLICY auth_sessions_refresh_lookup ON auth_sessions
  AS PERMISSIVE FOR SELECT
  USING (refresh_token_hash = current_setting('app.session_refresh_hash', true));

GRANT SELECT, INSERT ON auth_sessions TO argus_app;
GRANT UPDATE (revoked_at, last_used_at) ON auth_sessions TO argus_app;

-- Unique index for O(1) refresh lookup (also enforces no duplicate token hashes).
CREATE UNIQUE INDEX auth_sessions_refresh_hash_idx ON auth_sessions (refresh_token_hash);

-- Index for per-user session management (family revocation, session listing).
CREATE INDEX auth_sessions_tenant_user_idx ON auth_sessions (tenant_id, user_id);

-- Partial index for fast active-session queries.
CREATE INDEX auth_sessions_active_idx ON auth_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;
