data "azuread_client_config" "current" {}

# ============================================================================================================
# Azure Arc subscription prerequisites. A first-ever Arc onboarding on a fresh subscription 403s otherwise:
# `azcmagent connect` attempts to self-register Microsoft.HybridCompute, but the narrowly-scoped onboarding SP
# (Azure Connected Machine Onboarding role) isn't allowed to register a resource provider — that's a
# subscription-admin action. Registering them here, where the apply principal holds the rights, closes the gap.
# The EC2 instance depends_on these (ec2.tf) so the box can't boot-and-onboard before they're Registered.
# (Microsoft.GuestConfiguration is a third Arc prereq but is NOT needed to reach Connected — only for later
# guest-config policy / extensions, which this stack doesn't use. The azurerm provider's default `core`
# registration set does NOT include it, so add it as a third registration here if you ever attach
# machine-config policy on a fresh subscription.)
# ============================================================================================================
resource "azurerm_resource_provider_registration" "hybrid_compute" {
  name = "Microsoft.HybridCompute"
}

resource "azurerm_resource_provider_registration" "hybrid_connectivity" {
  name = "Microsoft.HybridConnectivity"
}

# ============================================================================================================
# Azure Arc onboarding identity. The EC2 box runs `azcmagent connect` once at first boot to project itself into
# Azure as an Arc connected machine — which gives it a real Entra system-assigned managed identity that mints
# Key Vault tokens on-box (the structural twin of Azure IMDS). The credential used for that ONE onboarding call
# is this service principal, scoped to the narrow `Azure Connected Machine Onboarding` role: it can onboard a
# machine into the experiment RG and NOTHING else — it cannot read Key Vault or any secret. After onboarding,
# the agent holds its own auto-rotating certificate identity; this onboarding cred is no longer needed on-box
# (cloud-init shreds its local copy).
# ============================================================================================================
resource "azuread_application" "arc_onboarding" {
  display_name = "${var.prefix}-arc-onboarding"
}

resource "azuread_service_principal" "arc_onboarding" {
  client_id = azuread_application.arc_onboarding.client_id
}

# The onboarding client secret. Short-ish lived; rotate by tainting. Sensitive — lands only in Terraform state
# (gitignored) and the AWS SSM SecureString below, never in the repo or env.
resource "azuread_application_password" "arc_onboarding" {
  application_id = azuread_application.arc_onboarding.id
  display_name   = "arc-onboarding (azcmagent connect)"
  end_date       = "2027-06-14T00:00:00Z"
}

# Onboarding-only ARM permission, scoped to the experiment RG. NOT a Key Vault role.
resource "azurerm_role_assignment" "arc_onboarding" {
  scope                            = azurerm_resource_group.exp.id
  role_definition_name             = "Azure Connected Machine Onboarding"
  principal_id                     = azuread_service_principal.arc_onboarding.object_id
  skip_service_principal_aad_check = true
}

# Deliver the onboarding client secret to the box via AWS SSM Parameter Store (SecureString, free vs Secrets
# Manager). The instance role reads it at boot (iam.tf), cloud-init runs `azcmagent connect`, then shreds the
# fetched copy. SecureString uses the AWS-managed aws/ssm KMS key (the instance role's kms:Decrypt is scoped to
# ViaService=ssm).
resource "aws_ssm_parameter" "arc_onboarding_secret" {
  # checkov:skip=CKV_AWS_337: the AWS-managed aws/ssm key is sufficient for a single use-once onboarding secret; a customer-managed CMK is a cost/ops add not warranted for the experiment.
  name        = "/${var.prefix}/arc-onboarding-secret"
  description = "Azure Arc onboarding SP client secret (used once by azcmagent connect at first boot)."
  type        = "SecureString"
  value       = azuread_application_password.arc_onboarding.value
  tags        = var.tags
}

# ============================================================================================================
# TWO-PHASE: grant the Arc machine's managed identity read access to the experiment Key Vault.
#
# The Arc machine + its managed identity do NOT exist until the EC2 box runs `azcmagent connect`. So:
#   1. First `apply` with arc_machine_connected = false (default) — creates everything above; the box boots and
#      onboards itself.
#   2. Confirm the machine shows "Connected" in Azure Arc (or `az connectedmachine show -n ${prefix}-ec2 -g ${prefix}-rg`).
#   3. Set arc_machine_connected = true and re-`apply` — the data source below resolves the now-existing machine
#      and grants its managed identity `Key Vault Secrets User` (read-only) on the experiment vault. Same RBAC
#      the live VM Managed Identity holds (infra/azure/terraform/keyvault.tf), just a different principal + vault.
# ============================================================================================================
data "azurerm_arc_machine" "exp" {
  count               = var.arc_machine_connected ? 1 : 0
  name                = "${var.prefix}-ec2"
  resource_group_name = azurerm_resource_group.exp.name
}

resource "azurerm_role_assignment" "arc_kv_secrets_user" {
  count                = var.arc_machine_connected ? 1 : 0
  scope                = azurerm_key_vault.exp.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = data.azurerm_arc_machine.exp[0].identity[0].principal_id
}
