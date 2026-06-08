variable "subscription_id" {
  type        = string
  description = "Azure subscription ID to deploy into."
}

variable "prefix" {
  type        = string
  default     = "argus"
  description = "Name prefix for all resources."
}

variable "location" {
  type        = string
  default     = "germanywestcentral"
  description = "Azure region. EU data residency: germanywestcentral (Frankfurt) pairs with the B2 eu-central buckets."
}

variable "domain" {
  type        = string
  default     = "4rgus.com"
  description = "Public domain (served via Cloudflare Tunnel). Recorded in tags/outputs; DNS + tunnel routes live in Cloudflare, not here."
}

variable "vm_size" {
  type        = string
  default     = "Standard_B2ms"
  description = "VM SKU. B2ms = 2 vCPU / 8 GiB (burstable), the cheapest that comfortably runs the whole single-VM stack. Resize to B4ms (16 GiB) if memory-tight."
}

variable "admin_username" {
  type        = string
  default     = "argusadmin"
  description = "VM admin user (for break-glass serial-console only — no inbound SSH is permitted; see the NSG)."
}

variable "admin_ssh_public_key" {
  type        = string
  description = "SSH PUBLIC key for the admin user (break-glass). Not a secret. Inbound 22 is denied by the NSG; this is for serial-console / future bastion use."

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-) ", var.admin_ssh_public_key))
    error_message = "admin_ssh_public_key must be an OpenSSH PUBLIC key (starts with ssh-ed25519 / ssh-rsa / ecdsa-)."
  }
}

variable "os_disk_type" {
  type        = string
  default     = "StandardSSD_LRS"
  description = "OS disk type. StandardSSD is the cost/perf sweet spot for a beta; Premium_LRS for production IOPS."
}

variable "data_disk_size_gb" {
  type        = number
  default     = 64
  description = "Data disk size (GiB) for Postgres + Docker volumes, kept separate from the OS disk so data survives a VM rebuild."
}

variable "data_disk_type" {
  type        = string
  default     = "StandardSSD_LRS"
  description = "Data disk type. Premium_LRS recommended once Postgres load grows."
}

variable "github_owner" {
  type        = string
  default     = "Dezoxy"
  description = "GitHub org/user that owns the repo (for the OIDC federated-credential subject)."
}

variable "github_repo" {
  type        = string
  default     = "secmes"
  description = "GitHub repository name (for the OIDC federated-credential subject)."
}

variable "github_deploy_subject" {
  type        = string
  default     = null
  description = "Override the federated-credential subject. Defaults to the `main` branch ref. Use e.g. 'repo:OWNER/REPO:environment:production' to bind deploys to a protected GitHub Environment instead."
}

variable "admin_object_id" {
  type        = string
  default     = null
  description = "Optional AAD object ID (you) granted Key Vault Secrets Officer + KV network access, so you can populate/rotate secrets. Leave null to manage secrets another way."
}

variable "admin_source_ip" {
  type        = string
  default     = null
  description = "Optional public IP/CIDR allowed through the Key Vault firewall for admin secret management (your laptop). The VM's own egress IP is always allowed."
}

variable "encryption_at_host_enabled" {
  type        = bool
  default     = true
  description = "Encrypt the VM host (OS/data caches + temp disk) on top of platform SSE. Requires the one-time subscription feature `Microsoft.Compute/EncryptionAtHost` (see README). Set false only if you can't register it."
}

variable "key_vault_purge_protection" {
  type        = bool
  default     = false
  description = "Key Vault purge protection. false eases teardown during the beta; set true for production (irreversible 7–90 day retention on delete)."
}

variable "tags" {
  type = map(string)
  default = {
    project = "argus"
    managed = "terraform"
    stack   = "vm"
  }
  description = "Tags applied to all resources."
}
