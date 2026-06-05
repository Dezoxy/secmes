terraform {
  required_version = ">= 1.7.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # Phase 0 uses local state. Before sharing/CI, migrate to a remote backend:
  # backend "azurerm" {
  #   resource_group_name  = "secmes-tfstate"
  #   storage_account_name = "secmestfstate"
  #   container_name       = "tfstate"
  #   key                  = "phase0.tfstate"
  # }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
