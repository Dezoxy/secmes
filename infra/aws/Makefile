# argus AWS deploy — operator helpers (run from your laptop, NOT in CI).
#
# Walks the real-deploy runbook (terraform/README.md → "Real deploy") as discrete `make` steps:
#   bootstrap → apply-1 → wait-arc → apply-2 → secrets
# There is deliberately NO single "do everything" target: the two `terraform apply`s create real, billable
# cloud infra (and prompt you for 'yes'), and `wait-arc` blocks on an external condition — each stays its own
# command you run on purpose. Each helper script PROMPTS for what it needs; pre-set an env var to skip a prompt.
#
# Auth expected: AWS creds (state + apply), `az login` as Key Vault Secrets Officer, `gh auth login` (repo admin).

.DEFAULT_GOAL := help
SCRIPTS := scripts
TF      := terraform -chdir=terraform
VAR_FILE     ?= real.tfvars
# The Arc machine + its resource group track var.prefix (default argus-exp). Override if you changed it:
#   make wait-arc PREFIX=argus
PREFIX       ?= argus-exp
WAIT_TIMEOUT ?= 1200

.PHONY: help bootstrap apply-1 wait-arc apply-2 populate-kv wire-github secrets

help: ## List targets (runbook order: bootstrap → apply-1 → wait-arc → apply-2 → secrets)
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

bootstrap: ## (once) create the encrypted/locked S3 backend for Terraform state
	$(SCRIPTS)/bootstrap-tfstate.sh

apply-1: ## terraform apply (phase 1): create the Key Vault + EC2; the box onboards into Arc
	$(TF) apply -var-file=$(VAR_FILE)

wait-arc: ## Poll until the Arc machine shows Connected (up to WAIT_TIMEOUT s; PREFIX overridable)
	@echo "waiting for Arc machine $(PREFIX)-ec2 (rg $(PREFIX)-rg) → Connected (timeout $(WAIT_TIMEOUT)s)…"
	@end=$$(( $$(date +%s) + $(WAIT_TIMEOUT) )); \
	while :; do \
	  st=$$(az connectedmachine show -n $(PREFIX)-ec2 -g $(PREFIX)-rg --query status -o tsv 2>/dev/null || true); \
	  if [ "$$st" = "Connected" ]; then echo "Arc: Connected"; break; fi; \
	  if [ $$(date +%s) -ge $$end ]; then echo "timed out (last status: $${st:-unknown})"; exit 1; fi; \
	  echo "  status=$${st:-<none>} … retry in 15s"; sleep 15; \
	done

apply-2: ## terraform apply (phase 2): grant the Arc identity Key Vault read
	$(TF) apply -var-file=$(VAR_FILE) -var arc_machine_connected=true

populate-kv: ## Populate Azure Key Vault — prompts for the 4 external creds, generates the rest
	$(SCRIPTS)/populate-keyvault.sh

wire-github: ## Set the cd-aws.yml GitHub vars/secret + gated environment — prompts for config
	$(SCRIPTS)/setup-github-cicd.sh

secrets: ## Run BOTH: populate Key Vault, then wire GitHub (stops if the first fails)
	$(MAKE) populate-kv
	$(MAKE) wire-github
