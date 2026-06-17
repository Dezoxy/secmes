# argus local tooling.
# Isolation model:
#   - Node deps + tests  -> pnpm, in ./node_modules (already isolated; run `pnpm install`)
#   - Python scanners    -> ./.venv (this Makefile; never global pip)
#   - Go binaries        -> Homebrew/mise or CI (static binaries, not venv-managed)

VENV := .venv
.DEFAULT_GOAL := help

.PHONY: help tools scan-py clean-tools up migrate seed api-dev down logs ps reset

# Compose project name (compose.yaml `name:`) — used to address named volumes from `docker run`.
COMPOSE_PROJECT := argus-local
# Owner connection to the local Postgres (migrations/seed/host API). LOCAL throwaway creds.
LOCAL_DATABASE_URL := postgres://argus:argus_local_dev@localhost:5432/argus
# Local MinIO root creds — LOCAL-ONLY throwaway defaults (the same fixed values on every dev machine), used
# to presign S3 URLs against the local emulator. NOT secrets. Prod uses a bucket-scoped Backblaze B2 key.

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

up: ## Start the local stack (postgres, redis, minio)
	docker compose up -d --build postgres redis minio minio-setup
	@echo ""
	@echo "Stack up. Auth is passkey-only — no IdP to provision (see docs/local-auth.md)."
	@echo "Then:  make migrate && make seed         # apply schema + seed the dev tenant"
	@echo "       make api-dev                      # API on :3000 (host; ephemeral dev session key)"
	@echo "       pnpm --filter @argus/web dev      # http://localhost:5173"

migrate: ## Apply DB migrations to the local Postgres (owner connection)
	DATABASE_URL="$(LOCAL_DATABASE_URL)" pnpm --filter @argus/api db:migrate

seed: ## Seed the local dev tenant (DEV_TENANT_ID) — the Action maps every login into it
	DATABASE_URL="$(LOCAL_DATABASE_URL)" pnpm --filter @argus/api db:seed:dev

api-dev: ## Run the API on the host (passkey auth; ephemeral dev session key; needs the stack up)
	DATABASE_URL="$(LOCAL_DATABASE_URL)" \
	REDIS_URL="redis://localhost:6379" \
	FRONTEND_ORIGIN="http://localhost:5173" WEBAUTHN_RP_ID="localhost" \
	S3_ENDPOINT="http://127.0.0.1:9000" S3_REGION="us-east-1" S3_BUCKET="argus-attachments" \
	S3_ACCESS_KEY_ID="minioadmin" S3_SECRET_ACCESS_KEY="minioadmin" S3_FORCE_PATH_STYLE="true" \
	pnpm --filter @argus/api dev

down: ## Stop the local stack (keeps data)
	docker compose down

logs: ## Tail local stack logs
	docker compose logs -f

ps: ## Show local stack status
	docker compose ps

reset: ## Stop the local stack and WIPE data volumes + any local override env files
	docker compose down -v
	rm -f .env.local apps/web/.env.local
