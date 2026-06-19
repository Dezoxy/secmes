-- 0042_friendships — mutual friendship graph for the contacts feature (Slice C).
-- contact-list-recovery-plan.md §Slice C. Threat-model: docs/threat-models/contact-list-recovery.md §R-friends.
--
-- METADATA ONLY: stores user-id pairs and request state — no keys, no content (invariant #1).
-- ACCEPTED-ONLY model: once accepted, requested_by is NULLed and expires_at is NULLed.
-- DECLINE / CANCEL = hard DELETE (no rejection ledger — bounds pre-conversation social graph exposure).
-- PENDING TTL: expires_at bounds the open-request window. Sweep follows the 0013 (attachments_cleanup)
-- pattern: argus_cleanup role + scoped RLS policies (see bottom of this migration). No SECURITY DEFINER
-- function. A NestJS ScheduleModule job or external cron calls DELETE via argus_cleanup in Slice D.
--
-- Canonical pair ordering: user_low_id = LEAST(a, b), user_high_id = GREATEST(a, b).
-- The UNIQUE constraint on (tenant_id, user_low_id, user_high_id) enforces one row per pair.
--
-- FORCE RLS: tenant isolation is the DB-level guarantee here, and FORCE RLS ensures it fires even for
-- the table owner. The caller-is-a-member predicate (a user only sees friendships they are a party to)
-- is enforced unconditionally at the APPLICATION layer — every FriendsService query appends a WHERE
-- clause requiring the caller to be user_low_id or user_high_id. By deliberate decision it is NOT a
-- second RLS policy (adequate under the single-tenant DEFAULT_TENANT_ID model where all access funnels
-- through the audited service). The Slice D security-boundary-auditor pass asserted that app-layer
-- predicate; friendships-rls.spec.ts covers the DB-level tenant isolation + cleanup posture.
--
-- down: DROP TABLE IF EXISTS friendships CASCADE;

CREATE TABLE IF NOT EXISTS friendships (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  user_low_id    UUID NOT NULL,   -- canonical: least(userId_a, userId_b)
  user_high_id   UUID NOT NULL,   -- canonical: greatest(userId_a, userId_b)
  status         TEXT NOT NULL,   -- 'pending' | 'accepted'
  requested_by   UUID,            -- who opened it; NULLed on accept
  expires_at     TIMESTAMPTZ,     -- pending TTL; NULL once accepted
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,     -- set on accept

  CONSTRAINT friendships_pair_unique UNIQUE (tenant_id, user_low_id, user_high_id),
  CONSTRAINT friendships_status_check CHECK (status IN ('pending', 'accepted')),
  CONSTRAINT friendships_low_ne_high CHECK (user_low_id <> user_high_id),
  CONSTRAINT friendships_canonical_order CHECK (user_low_id < user_high_id),
  -- Enforce TTL integrity: pending rows MUST carry an expiry (so the sweep can never miss them)
  -- and accepted rows MUST NOT (nulled on accept). Also requires requested_by for pending rows.
  CONSTRAINT friendships_pending_must_have_expiry
    CHECK (status <> 'pending' OR (expires_at IS NOT NULL AND requested_by IS NOT NULL)),
  CONSTRAINT friendships_accepted_must_clear_expiry
    CHECK (status <> 'accepted' OR (expires_at IS NULL AND requested_by IS NULL)),
  -- requested_by must be one of the two canonical parties (prevents orphaned direction metadata).
  CONSTRAINT friendships_requested_by_is_party
    CHECK (requested_by IS NULL OR requested_by = user_low_id OR requested_by = user_high_id),
  CONSTRAINT friendships_tenant_low_fk
    FOREIGN KEY (tenant_id, user_low_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT friendships_tenant_high_fk
    FOREIGN KEY (tenant_id, user_high_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_friendships_tenant_low  ON friendships (tenant_id, user_low_id);
CREATE INDEX IF NOT EXISTS idx_friendships_tenant_high ON friendships (tenant_id, user_high_id);

-- Invariant #3: FORCE RLS so even the table owner hits the tenant filter.
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships FORCE ROW LEVEL SECURITY;

-- Tenant-isolation policy (the only app-role policy on this table). The caller-is-a-member predicate
-- lives in the FriendsService WHERE clauses, not in RLS — see the header note above.
-- nullif guard: handles '' → NULL on pooled connections (GUC reverts to '' on txn end), consistent
-- with auth_sessions_isolation (0031) and other policies in this repo.
CREATE POLICY friendships_tenant_isolation ON friendships
  TO argus_app                                                              -- scope to app role; argus_cleanup gets its own policies below
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: argus_app may SELECT, INSERT (create request), UPDATE (accept — status, requested_by,
-- expires_at, resolved_at), DELETE (decline / cancel = hard delete). No DDL.
GRANT SELECT, INSERT, DELETE ON friendships TO argus_app;
GRANT UPDATE (status, requested_by, expires_at, resolved_at) ON friendships TO argus_app;

-- TTL sweep — follows the 0013 (attachments_cleanup) pattern. No SECURITY DEFINER function.
-- The argus_cleanup role (nologin nosuperuser nobypassrls noinherit) was created in 0013.
-- It sees + deletes ONLY expired pending rows — never live rows, never accepted friendships.
-- The tenant-isolation policy above uses nullif/missing_ok so it returns false (not throws) for
-- argus_cleanup; these policies OR-combine with it, giving argus_cleanup exactly what it needs.
CREATE POLICY friendships_cleanup_select ON friendships
  FOR SELECT
  TO argus_cleanup
  USING (status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW());

CREATE POLICY friendships_cleanup_delete ON friendships
  FOR DELETE
  TO argus_cleanup
  USING (status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW());

-- schema public USAGE is already granted to argus_cleanup in 0013.
GRANT SELECT (id, expires_at), DELETE ON friendships TO argus_cleanup;
