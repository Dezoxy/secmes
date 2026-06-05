resource "azurerm_resource_group" "this" {
  name     = "${var.prefix}-rg"
  location = var.location
  tags     = var.tags
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.prefix}-logs"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 30 # keep cost bounded; raise for prod
  tags                = var.tags
}

resource "azurerm_virtual_network" "this" {
  name                = "${var.prefix}-vnet"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = ["10.20.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "nodes" {
  name                 = "nodes"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.20.0.0/20"]
}

resource "azurerm_container_registry" "this" {
  name                = replace("${var.prefix}acr", "-", "")
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = false # use Workload ID / RBAC, never admin creds
  tags                = var.tags
}

resource "azurerm_kubernetes_cluster" "this" {
  name                = "${var.prefix}-aks"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = "${var.prefix}-aks"
  kubernetes_version  = var.kubernetes_version
  sku_tier            = "Free" # move to "Standard" for an uptime SLA later

  # --- the IRSA equivalent: federated pod identity, no secrets in pods ---
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # OPA/Gatekeeper admission control (enforce pod-security baselines cluster-side).
  azure_policy_enabled = true

  default_node_pool {
    name                         = "system"
    vm_size                      = var.node_vm_size
    node_count                   = var.system_node_count
    vnet_subnet_id               = azurerm_subnet.nodes.id
    orchestrator_version         = var.kubernetes_version
    only_critical_addons_enabled = true
    upgrade_settings {
      max_surge = "10%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  # Azure CNI Overlay + Cilium dataplane => eBPF + NetworkPolicy enforcement.
  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    load_balancer_sku   = "standard"
  }

  oms_agent {
    log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  }

  tags = var.tags
}

resource "azurerm_kubernetes_cluster_node_pool" "user" {
  name                  = "user"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.node_vm_size
  orchestrator_version  = var.kubernetes_version
  vnet_subnet_id        = azurerm_subnet.nodes.id

  auto_scaling_enabled = true
  min_count            = var.user_node_min
  max_count            = var.user_node_max

  tags = var.tags
}

# Let the cluster pull images from ACR without credentials.
resource "azurerm_role_assignment" "aks_acr_pull" {
  scope                            = azurerm_container_registry.this.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
