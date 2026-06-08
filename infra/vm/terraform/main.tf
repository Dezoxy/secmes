data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "this" {
  name     = "${var.prefix}-vm-rg"
  location = var.location
  tags     = var.tags
}

# --- Network. The VM is reachable ONLY outbound: ingress for the app rides the Cloudflare Tunnel
#     (cloudflared dials OUT), and deploys ride the Azure control plane (`az vm run-command`). So the NSG
#     allows NO inbound from the internet — there is nothing to expose. ---
resource "azurerm_virtual_network" "this" {
  name                = "${var.prefix}-vnet"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = ["10.30.0.0/24"]
  tags                = var.tags
}

resource "azurerm_subnet" "this" {
  name                 = "vm"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.30.0.0/27"]
  # Reach Key Vault over the Azure backbone via the subnet's identity (not the VM's egress IP, which may be
  # SNAT'd to an Azure-owned address and fail the KV firewall). The KV network_acls allow this subnet.
  service_endpoints = ["Microsoft.KeyVault"]
}

resource "azurerm_network_security_group" "this" {
  name                = "${var.prefix}-nsg"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  # No inbound allow rules. Azure's default DenyAllInBound already blocks the internet; this explicit rule
  # documents the intent and guarantees it even if defaults change. Ingress is Cloudflare Tunnel (outbound)
  # + `az vm run-command` (control plane) — neither needs an inbound port. NO 22/80/443 from the internet.
  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
  # Outbound is left at the Azure defaults (AllowInternetOutBound) so cloudflared, Key Vault, B2, GHCR, and
  # apt can reach out. Tightening egress to service tags / an Azure Firewall is an enterprise follow-up.
}

resource "azurerm_subnet_network_security_group_association" "this" {
  subnet_id                 = azurerm_subnet.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

# Public IP for EGRESS ONLY (Azure is retiring implicit default outbound, so explicit egress is required).
# It carries no inbound: the NSG denies all internet ingress. A NAT Gateway (no public IP on the VM) is the
# hardening upgrade — pricier, so a beta uses an egress public IP.
resource "azurerm_public_ip" "this" {
  name                = "${var.prefix}-egress-pip"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard" # Standard IPs are secure-by-default: no inbound unless an NSG rule allows it (none do)
  tags                = var.tags
}

resource "azurerm_network_interface" "this" {
  name                = "${var.prefix}-nic"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.this.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.this.id
  }
}

resource "azurerm_linux_virtual_machine" "this" {
  name                  = "${var.prefix}-vm"
  location              = azurerm_resource_group.this.location
  resource_group_name   = azurerm_resource_group.this.name
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.this.id]
  tags                  = var.tags

  # Key auth only; no password. (Inbound 22 is denied anyway — this key is break-glass for serial console.)
  disable_password_authentication = true
  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  # System-assigned Managed Identity: the VM fetches its own secrets from Key Vault with no stored creds.
  identity {
    type = "SystemAssigned"
  }

  # Encrypt the host (OS + data-disk caches + temp disk), on top of the platform SSE that already encrypts
  # the disks at rest — defense-in-depth for a box that stores the Postgres DB. Requires the one-time
  # subscription feature: `az feature register --namespace Microsoft.Compute --name EncryptionAtHost`
  # (see README). Set the var to false to skip if you can't register the feature.
  encryption_at_host_enabled = var.encryption_at_host_enabled

  os_disk {
    name                 = "${var.prefix}-osdisk"
    caching              = "ReadWrite"
    storage_account_type = var.os_disk_type
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # First-boot provisioning (docker, cloudflared deps, age, awscli v2, pg client). See cloud-init.yaml.
  custom_data = base64encode(file("${path.module}/cloud-init.yaml"))

  # Managed boot diagnostics (no storage account) → boot/console log VISIBILITY in the portal. NOTE: this is
  # not an interactive login path — with key-only auth and no password, the serial console has no credential
  # to accept. The real break-glass / recovery channel is `az vm run-command` (runs as root, control-plane,
  # needs no network or SSH).
  boot_diagnostics {}
}

# --- Data disk: Postgres + Docker volumes live here, separate from the OS disk, so a VM rebuild/resize
#     doesn't lose data. (Mounting + formatting is done in cloud-init / the deploy step.) ---
resource "azurerm_managed_disk" "data" {
  name                          = "${var.prefix}-datadisk"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  storage_account_type          = var.data_disk_type
  create_option                 = "Empty"
  disk_size_gb                  = var.data_disk_size_gb
  public_network_access_enabled = false # no disk export over the public network
  tags                          = var.tags
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.this.id
  lun                = 0
  caching            = "ReadWrite"
}
