# GitHub Actions authenticates to Azure with OIDC (a short-lived federated token) — NO client secret is
# ever stored. The deployer can do exactly ONE thing: run a command on the VM via the Azure control plane
# (`az vm run-command`). It cannot read Key Vault, touch storage, or reach the VM over the network.
resource "azuread_application" "github_deploy" {
  display_name = "${var.prefix}-github-deploy"
}

resource "azuread_service_principal" "github_deploy" {
  client_id = azuread_application.github_deploy.client_id
}

# Trust GitHub Actions runs of this repo. Default subject = the `main` branch; the release-on-tag deploy runs
# in the `prod` GitHub Environment, so set var.github_deploy_subject to bind to that environment (its
# OIDC token's subject is `...:environment:prod`, which the `main`-ref default would reject).
resource "azuread_application_federated_identity_credential" "github_deploy" {
  application_id = azuread_application.github_deploy.id
  display_name   = "github-actions-deploy"
  description    = "GitHub Actions OIDC for ${var.github_owner}/${var.github_repo}"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = coalesce(var.github_deploy_subject, "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/main")
}

# Least-privilege custom role: just enough to invoke run-command on the VM (not the broad built-in
# "Virtual Machine Contributor", which can resize/delete/extend the VM).
resource "azurerm_role_definition" "run_command" {
  name        = "${var.prefix}-run-command"
  scope       = azurerm_resource_group.this.id
  description = "Invoke run-command on the argus VM (CD deploys only)."

  permissions {
    actions = [
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/virtualMachines/runCommand/action",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.this.id]
}

resource "azurerm_role_assignment" "github_run_command" {
  scope              = azurerm_linux_virtual_machine.this.id
  role_definition_id = azurerm_role_definition.run_command.role_definition_resource_id
  principal_id       = azuread_service_principal.github_deploy.object_id
  # The SP is created in this same apply, so ARM can race AAD replication and fail with PrincipalNotFound;
  # skip the existence check so the first `terraform apply` is reliable (no manual retry).
  skip_service_principal_aad_check = true
}
