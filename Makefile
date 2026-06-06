# argus local tooling.
# Isolation model:
#   - Node deps + tests  -> pnpm, in ./node_modules (already isolated; run `pnpm install`)
#   - Python scanners    -> ./.venv (this Makefile; never global pip)
#   - Go binaries        -> Homebrew/mise or CI (static binaries, not venv-managed)

VENV := .venv
.DEFAULT_GOAL := help

.PHONY: help tools scan-py clean-tools up auth-provision migrate seed api-dev down logs ps reset

# Compose project name (compose.yaml `name:`) — used to address named volumes from `docker run`.
COMPOSE_PROJECT := argus-local
# Owner connection to the local Postgres (migrations/seed/host API). LOCAL throwaway creds.
LOCAL_DATABASE_URL := postgres://argus:argus_local_dev@localhost:5432/argus

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

up: ## Start the local stack (postgres, redis, minio, zitadel) + provision OIDC
	docker compose up -d --build postgres redis minio createbuckets zitadel-db zitadel-bootstrap-perms zitadel
	$(MAKE) auth-provision
	@echo ""
	@echo "Stack up. One-time: add '127.0.0.1 zitadel' to /etc/hosts (see docs/local-auth.md)."
	@echo "Then:  make migrate && make seed         # apply schema + seed the dev tenant"
	@echo "       make api-dev                      # API on :3000 (host; reads generated OIDC env)"
	@echo "       pnpm --filter @argus/web dev      # http://localhost:5173"
	@echo "Login: admin@argus-local.zitadel / Password1!"

auth-provision: ## (Re)provision Zitadel project/app/Action and materialise OIDC env files
	docker compose run --rm zitadel-provision
	@docker run --rm -v $(COMPOSE_PROJECT)_zitadel-bootstrap:/b alpine:3.20 cat /b/api.env.local > .env.local
	@docker run --rm -v $(COMPOSE_PROJECT)_zitadel-bootstrap:/b alpine:3.20 cat /b/web.env.local > apps/web/.env.local
	@echo "[auth] wrote .env.local + apps/web/.env.local"

migrate: ## Apply DB migrations to the local Postgres (owner connection)
	DATABASE_URL="$(LOCAL_DATABASE_URL)" pnpm --filter @argus/api db:migrate

seed: ## Seed the local dev tenant (DEV_TENANT_ID) — the Action maps every login into it
	DATABASE_URL="$(LOCAL_DATABASE_URL)" pnpm --filter @argus/api db:seed:dev

api-dev: ## Run the API on the host (loads generated OIDC env; needs the stack up + the /etc/hosts line)
	set -a; . ./.env.local; set +a; \
	DATABASE_URL="$(LOCAL_DATABASE_URL)" \
	REDIS_URL="redis://localhost:6379" \
	pnpm --filter @argus/api dev

down: ## Stop the local stack (keeps data)
	docker compose down

logs: ## Tail local stack logs
	docker compose logs -f

ps: ## Show local stack status
	docker compose ps

reset: ## Stop the local stack and WIPE data volumes + generated OIDC env files
	docker compose down -v
	rm -f .env.local apps/web/.env.local
