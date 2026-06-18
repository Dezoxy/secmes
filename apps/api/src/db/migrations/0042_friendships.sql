-- 0042_friendships — mutual friendship graph for the contacts feature (Slice C).
-- contact-list-recovery-plan.md §Slice C. Threat-model: docs/threat-models/contact-list-recovery.md §R-friends.
--
-- METADATA ONLY: stores user-id pairs and request state — no keys, no content (invariant #1).
-- ACCEPTED-ONLY model: once accepted, requested_by is NULLed and expires_at is NULLed.
-- DECLINE / CANCEL = hard DELETE (no rejection ledger — bounds pre-conversation social graph exposure).
-- PENDING TTL: expires_at bounds the open-request window. An external sweep (or pg_cron) should run:
--   DELETE FROM friendships WHERE status = 'pending' AND expires_at < NOW();
-- No NestJS scheduler exists yet — TODO: Slice D adds the periodic sweep (see R-friends-2 in threat model).
--
-- Canonical pair ordering: user_low_id = LEAST(a, b), user_high_id = GREATEST(a, b).
-- The UNIQUE constraint on (tenant_id, user_low_id, user_high_id) enforces one row per pair.
--
-- FORCE RLS: the caller-is-a-member predicate (status + member check) will be added as a second
-- policy in Slice D once the API layer is in place. The tenant-isolation policy here is the base layer;
-- FORCE RLS ensures it fires even for the table owner. Slice D's security-boundary-auditor pass must
-- assert the app-layer predicate before any endpoint goes live.
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

-- Base tenant-isolation policy. Slice D will add a second policy restricting reads/writes to rows
-- where the caller is a party to the friendship (the caller-is-a-member predicate).
-- nullif guard: handles '' → NULL on pooled connections (GUC reverts to '' on txn end), consistent
-- with auth_sessions_isolation (0031) and other policies in this repo.
CREATE POLICY friendships_tenant_isolation ON friendships
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: argus_app may SELECT, INSERT (create request), UPDATE (accept — status, requested_by,
-- expires_at, resolved_at), DELETE (decline / cancel = hard delete). No DDL.
GRANT SELECT, INSERT, DELETE ON friendships TO argus_app;
GRANT UPDATE (status, requested_by, expires_at, resolved_at) ON friendships TO argus_app;
