terraform {
  required_version = ">= 1.7.0"

  required_providers {
    # AWS — the experiment COMPUTE (EC2 + VPC + IAM + SSM Parameter Store). EU region pinned in provider below.
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Azure — secrets stay here. This module creates a SEPARATE experiment Key Vault (dummy values) + the Arc
    # onboarding service principal, so the EC2 box reads secrets via an Azure Arc managed identity (no static
    # cred). The live infra/azure/ stack and its prod Key Vault are NOT touched by this module.
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    # Generates format-valid DUMMY secret values for the experiment Key Vault (URL-safe passwords, the 32-byte
    # masterkey). Real external credentials (GHCR/B2/Cloudflare tokens) are seeded as labelled placeholders.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote S3 backend — the DEFAULT for this (real, AWS) deploy: encrypted + locked + versioned state that
  # survives laptop loss. State holds the Arc onboarding SP id, the KV id, and the GitHub OIDC role arn (no
  # app/runtime secrets when seed_dummy_secrets=false), so it must never be local or committed. One-time setup:
  # run `scripts/bootstrap-tfstate.sh` (creates the bucket + lock table + writes backend.hcl from
  # backend.hcl.example), then `terraform init -backend-config=backend.hcl`. (Only for a throwaway local-state
  # experiment: comment this partial block back out and re-`init` — but the real deploy always uses S3.)
  backend "s3" {}
}

# AWS compute lives in eu-central-1 (Frankfurt) for EU/GDPR residency parity with the live germanywestcentral
# stack. default_tags stamp every AWS resource so the experiment is easy to find + tear down.
provider "aws" {
  region = var.aws_region
  default_tags {
    tags = var.tags
  }
}

# Azure: only the experiment Key Vault + the Arc onboarding SP are created here. purge_soft_delete_on_destroy
# lets `terraform destroy` actually remove the throwaway experiment vault (it holds DUMMY values only).
provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = true
    }
  }
  subscription_id = var.azure_subscription_id
}

provider "azuread" {}
