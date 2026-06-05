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
  description = "Azure region. EU data residency: germanywestcentral (Frankfurt) or westeurope."
}

variable "kubernetes_version" {
  type        = string
  default     = "1.30"
  description = "AKS Kubernetes minor version."
}

variable "system_node_count" {
  type        = number
  default     = 1
  description = "System node pool size (keep small)."
}

variable "user_node_min" {
  type    = number
  default = 1
}

variable "user_node_max" {
  type    = number
  default = 3
}

variable "node_vm_size" {
  type        = string
  default     = "Standard_B2ms"
  description = "Burstable VMs keep beta cost down; move to D-series for steady load."
}

variable "enable_prod" {
  type        = bool
  default     = false
  description = "When true, AKS uses the SLA-backed Standard control-plane tier (required before customer beta). Default Free keeps dev cost down."
}

variable "tags" {
  type = map(string)
  default = {
    project = "argus"
    env     = "dev"
    owner   = "platform"
  }
}
