data "azurerm_client_config" "current" {}

# Experiment resource group — holds the throwaway Key Vault + the Arc machine projection. Distinct from the
# live argus-vm-rg so nothing here can touch production.
resource "azurerm_resource_group" "exp" {
  name     = "${var.prefix}-rg"
  location = var.azure_location
  tags     = var.tags
}

# A SEPARATE experiment Key Vault, seeded with DUMMY values. The EC2 box's Arc managed identity reads it (read
# only) — never the production vault. Same hardening posture as the live keyvault.tf: RBAC, default-deny
# firewall, soft-delete. The firewall allows ONLY the EC2 instance's Elastic IP: with compute on AWS there is
# no Azure subnet service endpoint, so this is an IP allow-list (a weaker network-identity binding than the
# live backbone service endpoint — recorded in docs/threat-models/cross-cloud-secret-fetch.md; Private Link is
# the production upgrade).
resource "azurerm_key_vault" "exp" {
  # checkov:skip=CKV2_AZURE_32: experiment vault reached via default-deny firewall + the EC2 EIP allow-list; private endpoint is the prod upgrade.
  name                = "${var.prefix}-kv-${substr(sha1(azurerm_resource_group.exp.id), 0, 6)}"
  location            = azurerm_resource_group.exp.location
  resource_group_name = azurerm_resource_group.exp.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = var.tags

  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = true

  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    # The EC2 egress = the Elastic IP (every KV call SNATs to it). No subnet service endpoint exists from AWS.
    # var.seed_admin_ip (optional) lets the apply principal's laptop through so the first apply can seed the
    # dummy secrets; otherwise seed/rotate from a host that egresses via the EIP. compact() drops the null.
    ip_rules = compact([aws_eip.this.public_ip, var.seed_admin_ip])
  }
}

# You (admin) may manage the dummy secrets (create/rotate) — required for the apply principal to seed them.
resource "azurerm_role_assignment" "admin_kv_secrets_officer" {
  count                = var.azure_admin_object_id == null ? 0 : 1
  scope                = azurerm_key_vault.exp.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.azure_admin_object_id
}

# ============================================================================================================
# Dummy secret seed. Proves the Arc -> Key Vault -> credential-file path end to end. Values are FORMAT-VALID
# but NOT real: passwords are URL-safe randoms and DSNs are derived from the generated owner password. The
# genuinely-external credentials (GHCR pull token, B2 secret key,
# Cloudflare tunnel token) are seeded as obvious PLACEHOLDERS — replace them with real values (or rotate the
# whole vault) before expecting the full stack to reach healthy. See the README. NEVER point this at prod.
# ============================================================================================================

# URL-safe (A-Za-z0-9 ⊂ A-Za-z0-9._~-) passwords + the 32-byte masterkey. special=false keeps them inside the
# unreserved set deploy.sh enforces for the redis/glitchtip passwords.
locals {
  generated_secret_lengths = {
    "argus-postgres-owner-password" = 32
    "argus-redis-password"          = 32
    "argus-grafana-admin-password"  = 24
    "argus-backup-db-password"      = 32
    "argus-cleanup-db-password"     = 32
    "argus-glitchtip-db-password"   = 32
    "argus-glitchtip-secret-key"    = 50
    # VoIP TURN relay (VoIP V1, PR 6/14): HMAC-SHA1 shared secret for coturn use-auth-secret + cred minting.
    "argus-turn-shared-secret" = 32
  }
  # External credentials and non-generatable keys — a dummy here is non-functional; replace with real values
  # before expecting the full stack to reach healthy. See the README and populate-keyvault.sh for how to
  # generate the Ed25519 key (openssl genpkey -algorithm Ed25519).
  placeholder_secrets = {
    "argus-s3-secret-access-key" = "REPLACE-with-real-B2-secret-access-key"
    "argus-b2-app-key"           = "REPLACE-with-real-B2-backup-app-key"
    "argus-b2-cors-app-key"      = "REPLACE-with-real-B2-CORS-app-key"
    "argus-tunnel-token"         = "REPLACE-with-real-cloudflare-tunnel-token"
    "argus-ghcr-token"           = "REPLACE-with-real-ghcr-read-packages-token"
    # Phase 1 session tokens: generate with `openssl genpkey -algorithm Ed25519` and store the PKCS8 PEM here.
    # Without a valid key the API cannot start. populate-keyvault.sh generates this automatically.
    "argus-session-signing-key" = "REPLACE-with-Ed25519-PKCS8-PEM-from-openssl-genpkey"
    # Signed DB backups (BKP-2 follow-up): Ed25519 PKCS8 PEM, MANDATORY in fetch-keyvault-secrets.sh, so the
    # seed must be non-empty or the AWS-experiment stack won't boot. This dummy only satisfies the fetch
    # presence gate; an invalid PEM correctly fails CLOSED at sign time (slice 2). populate-keyvault.sh
    # generates the real key.
    "argus-backup-signing-key" = "REPLACE-with-Ed25519-PKCS8-PEM-from-openssl-genpkey"
    # VoIP TURN relay (VoIP V1, PR 6/14): TLS cert + key for TURNS/5349 are DNS-01 issued, not auto-generated.
    # Dummy values satisfy the fetch presence gate; coturn (PR 7) fails CLOSED at TLS-load time with a dummy —
    # correct behavior for an experiment stack before issue-turn-cert.sh is run. Provision the real values with:
    #   infra/stack/coturn/issue-turn-cert.sh  (see infra/stack/coturn/README.md)
    "argus-turn-tls-cert" = "REPLACE-with-TURNS-fullchain-PEM-from-issue-turn-cert.sh"
    "argus-turn-tls-key"  = "REPLACE-with-TURNS-private-key-PEM-from-issue-turn-cert.sh"
  }
}

resource "random_password" "gen" {
  for_each         = var.seed_dummy_secrets ? local.generated_secret_lengths : {}
  length           = each.value
  special          = false # alphanumeric ⊂ the URL-unreserved set deploy.sh enforces
  override_special = ""
}

locals {
  # Owner DSN (migrations) + app DSN. The app role/password reconciliation is app-bootstrapping out of scope
  # for the infra experiment — the fetch delivers the file regardless; api DB connectivity may need manual role
  # setup. argus_app password is a derived random so the files are non-empty + well-formed.
  derived_secrets = var.seed_dummy_secrets ? {
    "argus-migration-database-url" = "postgres://argus:${random_password.gen["argus-postgres-owner-password"].result}@postgres:5432/argus"
    "argus-database-url"           = "postgres://argus_app:${random_password.gen["argus-redis-password"].result}@postgres:5432/argus"
  } : {}

  seeded_secrets = merge(
    { for k, r in random_password.gen : k => r.result },
    local.placeholder_secrets,
    local.derived_secrets,
  )
}

resource "azurerm_key_vault_secret" "seed" {
  for_each        = var.seed_dummy_secrets ? local.seeded_secrets : {}
  name            = each.key
  value           = each.value
  key_vault_id    = azurerm_key_vault.exp.id
  content_type    = "text/plain"           # CKV_AZURE_114 / semgrep keyvault-content-type
  expiration_date = "2027-06-14T00:00:00Z" # CKV_AZURE_41 / semgrep keyvault-ensure-secret-expires — dummy secrets expire

  # The apply principal needs Secrets Officer first (you, via azure_admin_object_id, or another grant).
  depends_on = [azurerm_role_assignment.admin_kv_secrets_officer]
}
