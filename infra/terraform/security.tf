# Microsoft Defender for Cloud. Both off by default to avoid surprise cost;
# flip the variables on when you want cloud posture / container threat detection.

variable "enable_defender_cspm" {
  type        = bool
  default     = false
  description = "Enable Defender CSPM (cloud security posture). Foundational tier is free."
}

variable "enable_defender_containers" {
  type        = bool
  default     = false
  description = "Enable Defender for Containers (registry + runtime). Paid per resource."
}

resource "azurerm_security_center_subscription_pricing" "cspm" {
  count         = var.enable_defender_cspm ? 1 : 0
  tier          = "Standard"
  resource_type = "CloudPosture"
}

resource "azurerm_security_center_subscription_pricing" "containers" {
  count         = var.enable_defender_containers ? 1 : 0
  tier          = "Standard"
  resource_type = "Containers"
}
