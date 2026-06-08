output "resource_group" {
  value       = azurerm_resource_group.this.name
  description = "Resource group holding the VM stack."
}

output "vm_name" {
  value       = azurerm_linux_virtual_machine.this.name
  description = "VM name — the target for `az vm run-command invoke`."
}

output "vm_egress_ip" {
  value       = azurerm_public_ip.this.ip_address
  description = "VM public EGRESS IP (no inbound is allowed). Point nothing at it; it's for outbound + Key Vault firewall allow-listing only."
}

output "key_vault_name" {
  value       = azurerm_key_vault.this.name
  description = "Key Vault name — populate runtime secrets here; the VM Managed Identity reads them."
}

output "vm_identity_principal_id" {
  value       = azurerm_linux_virtual_machine.this.identity[0].principal_id
  description = "VM Managed Identity principal ID (granted Key Vault Secrets User)."
}

output "github_deploy_client_id" {
  value       = azuread_application.github_deploy.client_id
  description = "Set as the AZURE_CLIENT_ID secret/var in GitHub Actions for OIDC login."
}

output "azure_tenant_id" {
  value       = data.azurerm_client_config.current.tenant_id
  description = "Set as AZURE_TENANT_ID in GitHub Actions."
}

output "azure_subscription_id" {
  value       = var.subscription_id
  description = "Set as AZURE_SUBSCRIPTION_ID in GitHub Actions."
}

# Convenience: the exact run-command call CD will make (no SSH, no open port).
output "deploy_run_command_hint" {
  value       = "az vm run-command invoke -g ${azurerm_resource_group.this.name} -n ${azurerm_linux_virtual_machine.this.name} --command-id RunShellScript --scripts @infra/vm/deploy/deploy.sh"
  description = "How the CD pipeline reaches the VM through the Azure control plane."
}
