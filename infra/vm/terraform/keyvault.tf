# Key Vault holds every runtime secret (DB passwords, B2 keys, Redis password, Zitadel masterkey, the
# cloudflared tunnel token, …). The VM's Managed Identity reads them at deploy time — no secret is ever in
# the repo, env, or Terraform inputs. (The age backup PRIVATE key deliberately does NOT live here on the VM
# path — it's restore-only; keep it in a separate vault/offline.)
resource "azurerm_key_vault" "this" {
  name                = "${var.prefix}-kv-${substr(sha1(azurerm_resource_group.this.id), 0, 6)}" # globally-unique, deterministic
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = var.tags

  # RBAC (not legacy access policies): least-privilege role assignments below.
  rbac_authorization_enabled = true

  soft_delete_retention_days = 7
  # Always on (secure default + required by the CI scanners). To tear down during dev, recover the
  # soft-deleted vault (`az keyvault recover`) or wait out the 7-day retention, rather than weakening this.
  purge_protection_enabled = true

  # Default-deny firewall. The VM reaches the vault via the subnet's Key Vault service endpoint (deterministic
  # over the Azure backbone — not the VM's egress IP, which may be SNAT'd and fail the firewall). Your
  # optional admin IP is allowed for managing secrets from your laptop. `AzureServices` bypass lets trusted
  # first-party services through.
  network_acls {
    default_action             = "Deny"
    bypass                     = "AzureServices"
    virtual_network_subnet_ids = [azurerm_subnet.this.id]
    ip_rules                   = compact([var.admin_source_ip])
  }
}

# The VM Managed Identity may READ secrets only (get/list) — never write/manage them.
resource "azurerm_role_assignment" "vm_kv_secrets_user" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_virtual_machine.this.identity[0].principal_id
}

# Optional: you (admin) may manage secrets (create/rotate). Requires admin_object_id + admin_source_ip.
resource "azurerm_role_assignment" "admin_kv_secrets_officer" {
  count                = var.admin_object_id == null ? 0 : 1
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.admin_object_id
}
