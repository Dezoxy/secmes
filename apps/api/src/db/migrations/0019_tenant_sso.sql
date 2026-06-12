CREATE TABLE tenant_sso_configs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  zitadel_org_id  text        NOT NULL,
  zitadel_idp_id  text        NOT NULL,
  provider_type   text        NOT NULL CHECK (provider_type IN ('oidc_generic','google','entra','okta')),
  provider_name   text        NOT NULL CHECK (char_length(provider_name) <= 100),
  issuer_url      text        NOT NULL CHECK (char_length(issuer_url) <= 512),
  client_id       text        NOT NULL CHECK (char_length(client_id) <= 256),
  login_url       text        NOT NULL CHECK (char_length(login_url) <= 1024),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_sso_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sso_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_sso_configs_isolation ON tenant_sso_configs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE INDEX tenant_sso_configs_tenant_idx ON tenant_sso_configs (tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_sso_configs TO argus_app;
