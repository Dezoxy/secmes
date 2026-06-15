# argus AWS deploy — operator helpers (run from your laptop, NOT in CI).
#
# Order: run these AFTER `terraform apply` has created the Key Vault + EC2 — the helpers read `terraform
# output` and need the vault to exist. Each script PROMPTS for the values it needs; pre-set the matching env
# var to skip a prompt (unattended runs). Full sequence: terraform/README.md → "Real deploy".
#
# Auth expected: `az login` (Key Vault Secrets Officer on the vault) + `gh auth login` (repo admin).

.DEFAULT_GOAL := help
SCRIPTS := scripts

.PHONY: help bootstrap-state populate-kv wire-github secrets

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-16s %s\n", $$1, $$2}'

bootstrap-state: ## (once) create the encrypted/locked S3 backend for Terraform state
	$(SCRIPTS)/bootstrap-tfstate.sh

populate-kv: ## Populate Azure Key Vault — prompts for the 4 external creds, generates the rest
	$(SCRIPTS)/populate-keyvault.sh

wire-github: ## Set the cd-aws.yml GitHub vars/secret + gated environment — prompts for config
	$(SCRIPTS)/setup-github-cicd.sh

secrets: ## Run BOTH in order: populate Key Vault, then wire GitHub (stops if the first fails)
	$(MAKE) populate-kv
	$(MAKE) wire-github
