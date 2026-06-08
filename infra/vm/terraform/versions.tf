terraform {
  required_version = ">= 1.7.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }

  # Local state for now. Terraform state for this stack contains sensitive material (the GitHub OIDC app
  # ids, Key Vault ids) — DO NOT commit `terraform.tfstate`. Before sharing/CI, migrate to a remote backend
  # with encryption + locking:
  # backend "azurerm" {
  #   resource_group_name  = "argus-tfstate"
  #   storage_account_name = "argustfstate"
  #   container_name       = "tfstate"
  #   key                  = "vm.tfstate"
  # }
}

provider "azurerm" {
  features {
    key_vault {
      # Beta convenience: let `terraform destroy` actually remove the vault. Flip to false (or set
      # var.key_vault_purge_protection = true) for production so secrets can't be hard-deleted.
      purge_soft_delete_on_destroy = true
    }
  }
  subscription_id = var.subscription_id
}

provider "azuread" {}
