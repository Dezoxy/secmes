#!/usr/bin/env bash
# argus — populate the (REAL) Azure Key Vault an AWS deploy reads via Arc. Sets the MANDATORY runtime secret
# set the stack needs to reach healthy: generates the generatable values (passwords + the Zitadel masterkey),
# derives the two DSNs, and takes the four EXTERNAL credentials from the environment.
#
# Idempotent + safe to re-run: by default it SKIPS any secret that already exists (never clobbers a live
# value). Pass --rotate to overwrite existing values (rotation — expect a redeploy to pick them up).
#
# NOT set here (provision during "arming" after the first deploy — fetch-keyvault-secrets.sh seeds them empty
# until then): stripe-secret-key, stripe-webhook-secret, operator-api-key, sentry-dsn,
# zitadel-management-pat, zitadel-login-pat.
#
# Auth: `az login` first, as a principal with **Key Vault Secrets Officer** on the vault (Terraform grants this
# via var.azure_admin_object_id). Secret VALUES are written via `--file` from a 0600 temp file — NEVER on argv
# (so not in `ps`/`/proc/<pid>/cmdline`) — and are never logged (names + status only).
#
# Usage:
#   export ARGUS_S3_SECRET_ACCESS_KEY=... ARGUS_B2_APP_KEY=... ARGUS_TUNNEL_TOKEN=... ARGUS_GHCR_TOKEN=...
#   ./populate-keyvault.sh [--vault <name>] [--rotate]
#   # vault name: --vault  >  $ARGUS_KEY_VAULT  >  `terraform -chdir=../terraform output -raw key_vault_name`
set -euo pipefail

ROTATE=0
KV="${ARGUS_KEY_VAULT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
  --vault)
    KV="${2:?--vault needs a value}"
    shift 2
    ;;
  --rotate)
    ROTATE=1
    shift
    ;;
  *)
    echo "unknown arg: $1" >&2
    exit 2
    ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
if [ -z "$KV" ]; then
  KV="$(terraform -chdir="$TF_DIR" output -raw key_vault_name 2>/dev/null || true)"
fi
[ -n "$KV" ] || {
  echo "FATAL: no vault name (pass --vault, set ARGUS_KEY_VAULT, or run after 'terraform apply')" >&2
  exit 1
}

log() { printf 'populate-kv: %s\n' "$*"; } # names/status only — never a secret value
command -v az >/dev/null || {
  log "FATAL: az CLI not found"
  exit 1
}

# URL-unreserved (alphanumeric subset) of length $1 — matches the charset deploy.sh enforces for role logins.
gen_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }

secret_exists() { az keyvault secret show --vault-name "$KV" --name "$1" --only-show-errors >/dev/null 2>&1; }

# Set a secret VALUE without ever putting it on argv: write to a 0600 temp file + `--file --encoding utf-8`.
set_secret() { # $1 = name ; $2 = value
  local f
  f="$(mktemp)"
  chmod 600 "$f"
  printf '%s' "$2" >"$f"
  az keyvault secret set --vault-name "$KV" --name "$1" --file "$f" --encoding utf-8 \
    --only-show-errors >/dev/null
  rm -f "$f"
  log "set $1"
}

# Skip-if-exists wrapper (honours --rotate).
put() { # $1 = name ; $2 = value
  if [ "$ROTATE" -eq 0 ] && secret_exists "$1"; then
    log "exists, skipping $1 (use --rotate to overwrite)"
    return 0
  fi
  set_secret "$1" "$2"
}

# Read a secret's current value (used to derive the migration DSN from the owner password).
get_secret() { az keyvault secret show --vault-name "$KV" --name "$1" --query value -o tsv --only-show-errors; }

log "target vault: $KV  (rotate=$ROTATE)"

# --- Generated runtime secrets (lengths mirror infra/aws/terraform/keyvault.tf's generated_secret_lengths) ---
put argus-postgres-owner-password "$(gen_alnum 32)"
put argus-redis-password "$(gen_alnum 32)"
put argus-zitadel-db-password "$(gen_alnum 32)"
put argus-grafana-admin-password "$(gen_alnum 24)"
put argus-backup-db-password "$(gen_alnum 32)"
put argus-cleanup-db-password "$(gen_alnum 32)"
put argus-glitchtip-db-password "$(gen_alnum 32)"
put argus-glitchtip-secret-key "$(gen_alnum 50)"
put argus-zitadel-masterkey "$(gen_alnum 32)" # Zitadel requires EXACTLY 32 bytes; 32 ASCII chars = 32 bytes
# Zitadel bootstrap admin (first-init only; change + enable MFA after first login). Guarantee the default
# complexity policy (upper+lower+digit+symbol) by appending fixed-class chars to an alphanumeric base.
put argus-zitadel-admin-password "$(gen_alnum 20)Aa9."

# --- Derived DSNs. Build from the CURRENT password values so they always match the role passwords deploy.sh
#     sets. database_url uses a DEDICATED argus_app password (NOT the redis pw — closes audit infra-4). ---
if [ "$ROTATE" -eq 1 ] || ! secret_exists argus-database-url; then
  put argus-database-url "postgres://argus_app:$(gen_alnum 32)@postgres:5432/argus"
else
  log "exists, skipping argus-database-url"
fi
if [ "$ROTATE" -eq 1 ] || ! secret_exists argus-migration-database-url; then
  _owner="$(get_secret argus-postgres-owner-password)"
  put argus-migration-database-url "postgres://argus:${_owner}@postgres:5432/argus"
  _owner=""
else
  log "exists, skipping argus-migration-database-url"
fi

# --- External credentials (operator-supplied via env; fail closed if a NEW secret is needed but unset) ---
put_external() { # $1 = kv name ; $2 = env var name
  if [ "$ROTATE" -eq 0 ] && secret_exists "$1"; then
    log "exists, skipping $1"
    return 0
  fi
  local val="${!2:-}"
  [ -n "$val" ] || {
    log "FATAL: $1 not set and \$$2 is empty — export $2 (the real credential) and re-run"
    exit 1
  }
  set_secret "$1" "$val"
}
put_external argus-s3-secret-access-key ARGUS_S3_SECRET_ACCESS_KEY
put_external argus-b2-app-key ARGUS_B2_APP_KEY
put_external argus-tunnel-token ARGUS_TUNNEL_TOKEN
put_external argus-ghcr-token ARGUS_GHCR_TOKEN

log "done. Mandatory secrets present. Arming secrets (stripe/operator/sentry/zitadel-*-pat) are set later."
