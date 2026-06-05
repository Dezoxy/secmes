output "resource_group" {
  value = azurerm_resource_group.this.name
}

output "aks_name" {
  value = azurerm_kubernetes_cluster.this.name
}

output "acr_login_server" {
  value = azurerm_container_registry.this.login_server
}

output "oidc_issuer_url" {
  description = "Use this when configuring Entra Workload ID federated credentials."
  value       = azurerm_kubernetes_cluster.this.oidc_issuer_url
}

output "get_credentials_cmd" {
  value = "az aks get-credentials --resource-group ${azurerm_resource_group.this.name} --name ${azurerm_kubernetes_cluster.this.name}"
}
