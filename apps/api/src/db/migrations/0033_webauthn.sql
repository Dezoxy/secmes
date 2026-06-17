-- 0033_webauthn — WebAuthn passkey tables + users.email nullable + DEFAULT_TENANT_ID bootstrap.
-- Phase 2 of the private-messenger redesign (private-messenger-redesign-plan.md:203-259).
-- Threat models: docs/threat-models/passkey-auth.md, docs/threat-models/registration-and-tenancy.md.

-- webauthn_credentials: one row per registered passkey. FORCE RLS + leading tenant_id index (invariant #3).
-- credential_id is globally unique (NOT tenant-scoped) — the authenticate step resolves a credential
-- before any tenant context, so the UNIQUE INDEX is non-tenant-scoped. See passkey-auth.md §T2.
CREATE TABLE webauthn_credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  credential_id   bytea       NOT NULL,
  public_key      bytea       NOT NULL,    -- COSE-encoded public key (server-auth only; not E2EE — passkey-auth.md §passkey-vs-mls)
  counter         bigint      NOT NULL DEFAULT 0,
  aaguid          uuid,                    -- best-effort, often zero under attestationType:'none' (passkey-auth.md §T8)
  backed_up       boolean     NOT NULL DEFAULT false,
  transports      text[],
  device_label    text,                    -- user-assigned friendly name
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY;

-- Standard tenant isolation (mirrors auth_sessions_isolation in 0031).
CREATE POLICY webauthn_credentials_isolation ON webauthn_credentials
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Global uniqueness (non-tenant-scoped) — see comment above.
CREATE UNIQUE INDEX webauthn_credentials_credential_id_idx ON webauthn_credentials (credential_id);
-- Per-user credential list/management (leading tenant_id per invariant #3).
CREATE INDEX webauthn_credentials_tenant_user_idx ON webauthn_credentials (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE ON webauthn_credentials TO argus_app;

-- webauthn_challenges: ephemeral ceremony state. No-RLS routing table — no tenant context exists
-- at registration, and the table holds no tenant-private data; access is gated by the server-generated
-- ceremony_id UUID (122+ bits of randomness). See registration-and-tenancy.md §T5.
CREATE TABLE webauthn_challenges (
  ceremony_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_hash text        NOT NULL,  -- hex of the 32 raw CSPRNG challenge bytes (NOT a hash; see redeemCode/getAuthenticationOptions)
  purpose        text        NOT NULL,  -- 'register' | 'authenticate'
  argus_id       text,                  -- generated at redeem; same value must flow to options → verify → user insert
  invite_id      uuid,                  -- invite consumed atomically in register/verify tx (registration-and-tenancy.md §T2)
  expires_at     timestamptz NOT NULL   -- now() + interval '5 minutes'; delete-on-use is primary control, this is backstop
);

-- No RLS — see comment above. Delete-on-use via DELETE…RETURNING in service code.
GRANT SELECT, INSERT, DELETE ON webauthn_challenges TO argus_app;
CREATE INDEX webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);

-- Make users.email nullable. Phase 2 is the first to insert email-less passkey users.
-- Existing OIDC users retain their email values. Bulk null-out of existing emails is deferred
-- to Phase 6 (after the OIDC email writer is removed). See registration-and-tenancy.md §T7.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Bootstrap DEFAULT_TENANT_ID: the single shared tenant for all Phase 2+ passkey users.
-- Idempotent (ON CONFLICT DO NOTHING). RLS: tenants has FORCE RLS with tenants_self_isolation;
-- this INSERT runs at migration time under the migration role (owner/superuser) which bypasses RLS.
-- plan_tier='free' satisfies the NOT NULL constraint.
INSERT INTO tenants (id, name, plan_tier)
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'free')
ON CONFLICT (id) DO NOTHING;
