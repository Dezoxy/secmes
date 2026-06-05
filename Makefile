# secmes local tooling.
# Isolation model:
#   - Node deps + tests  -> pnpm, in ./node_modules (already isolated; run `pnpm install`)
#   - Python scanners    -> ./.venv (this Makefile; never global pip)
#   - Go binaries        -> Homebrew/mise or CI (static binaries, not venv-managed)

VENV := .venv
.DEFAULT_GOAL := help

.PHONY: help tools scan-py clean-tools up down logs ps reset

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

tools: ## Create .venv and install isolated Python security scanners (semgrep, checkov)
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements-dev.txt
	@echo "Python scanners ready in $(VENV)/. For Node deps run 'pnpm install'."

scan-py: ## Run the Python security scanners locally (semgrep + checkov)
	$(VENV)/bin/semgrep scan --config .semgrep --error --quiet
	$(VENV)/bin/checkov -d . --quiet --compact

clean-tools: ## Remove the Python venv
	rm -rf $(VENV)

up: ## Start the local stack in Docker (postgres, redis, minio, api)
	docker compose up -d --build

down: ## Stop the local stack (keeps data)
	docker compose down

logs: ## Tail local stack logs
	docker compose logs -f

ps: ## Show local stack status
	docker compose ps

reset: ## Stop the local stack and WIPE data volumes
	docker compose down -v
