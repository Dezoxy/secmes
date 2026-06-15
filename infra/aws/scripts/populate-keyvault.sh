#!/usr/bin/env bash
# argus — populate the (REAL) Azure Key Vault an AWS deploy reads via Arc. Sets the MANDATORY runtime secret
# set the stack needs to reach healthy: generates the generatable values (passwords + the Zitadel masterkey),
# derives the two DSNs, and takes the four EXTERNAL credentials from the environment.
#
# Idempotent + safe to re-run: by default it SKIPS any secret that already exists (never clobbers a live
# value). Pass --rotate to overwrite existing values (rotation — expect a redeploy to pick them up). NOT every
# secret is rotatable: the SET-ONCE group (postgres/zitadel-db/glitchtip-db POSTGRES_PASSWORD, grafana admin,
# zitadel masterkey + bootstrap admin) is consumed only at a component's FIRST init and is NOT reconciled on
# redeploy — overwriting it breaks the component's auth or silently has no effect, so --rotate SKIPS it.
# Rotating one of those is a per-component DR step. Rotatable: the argus_app/cleanup/backup DB logins (deploy.sh
# re-applies them) + redis (requirepass re-read from its config file each boot).
#
# NOT set here (provision during "arming" after the first deploy — fetch-keyvault-secrets.sh seeds them empty
# until then): stripe-secret-key, stripe-webhook-secret, operator-api-key, sentry-dsn,
# zitadel-management-pat, zitadel-login-pat.
#
# This script only POPULATES the vault. The generated passwords are APPLIED to the Postgres roles by deploy.sh
# ON THE BOX (the only host with DB access): the argus_app/argus_cleanup/argus_backup role logins (see #203 /
# infra/stack/deploy/deploy.sh) and the owner password at Postgres first-init. The operator's machine cannot
# reach the DB (no inbound; SSM-only), so applying role passwords is necessarily deploy.sh's job, not this.
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

# Secret values are staged in a private temp dir (0700) and removed on ANY exit — including a failed `az`
# under `set -e` — so a plaintext value never lingers on disk. Mirrors infra/backup/backup-db.sh.
umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT

# URL-unreserved (alphanumeric subset) of length $1 — matches the charset deploy.sh enforces for role logins.
# CSPRNG via /dev/urandom. Pipefail-safe: `head` bounds the SOURCE (reads n*8 bytes from the file, exits 0) so
# `tr` drains a FINITE stream to EOF — no `tr | head` SIGPIPE (which would be 141 under `set -o pipefail`).
# Truncation to exactly $1 is done in the shell (no trailing `| head`); the loop covers the rare short draw.
gen_alnum() { # $1 = number of chars
  local n="$1" out=""
  while [ "${#out}" -lt "$n" ]; do
    out="$out$(LC_ALL=C head -c "$((n * 8))" /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${out:0:n}"
}

secret_exists() { az keyvault secret show --vault-name "$KV" --name "$1" --only-show-errors >/dev/null 2>&1; }

# Set a secret VALUE without ever putting it on argv: write to the 0700-dir temp file + `--file`. The file is
# overwritten each call and removed by the EXIT trap (so a value never survives a failure mid-run).
set_secret() { # $1 = name ; $2 = value
  local f="$WORKDIR/val"
  printf '%s' "$2" >"$f"
  az keyvault secret set --vault-name "$KV" --name "$1" --file "$f" --encoding utf-8 \
    --only-show-errors >/dev/null
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

# Set-once wrapper: NEVER overwritten, even with --rotate. For values whose blind rotation is destructive (see
# the header note — Zitadel masterkey, Postgres owner password). Rotating them is a separate DR flow.
put_once() { # $1 = name ; $2 = value
  if secret_exists "$1"; then
    log "exists, NOT rotating $1 (set-once — rotating it is a separate DR procedure)"
    return 0
  fi
  set_secret "$1" "$2"
}

# Read a secret's current value (used to derive the migration DSN from the owner password).
get_secret() { az keyvault secret show --vault-name "$KV" --name "$1" --query value -o tsv --only-show-errors; }

log "target vault: $KV  (rotate=$ROTATE)"
if [ "$ROTATE" -eq 1 ]; then
  log "WARNING: --rotate overwrites Key Vault values but does NOT change them on the RUNNING stack."
  log "  Redeploy after this so deploy.sh re-applies the argus_app/argus_cleanup/argus_backup role logins."
  log "  Set-once secrets (postgres/zitadel-db/glitchtip-db owners, grafana admin, zitadel masterkey + admin)"
  log "  are NOT rotated here — rotating one is a per-component DR step (re-encrypt / ALTER ROLE / reset)."
fi

# --- Generated runtime secrets (lengths mirror infra/aws/terraform/keyvault.tf's generated_secret_lengths).
#     Split by rotation safety — see the header note. ---
# Rotatable (reconciled on the next deploy, or re-read from config each boot):
put argus-redis-password "$(gen_alnum 32)"   # redis requirepass — re-read from its config file each boot
put argus-backup-db-password "$(gen_alnum 32)"  # argus_backup login — deploy.sh re-applies via ALTER ROLE
put argus-cleanup-db-password "$(gen_alnum 32)" # argus_cleanup login — deploy.sh re-applies via ALTER ROLE
put argus-glitchtip-secret-key "$(gen_alnum 50)" # Django SECRET_KEY — env each boot (only logs sessions out)
# Set-once (consumed at a component's first init, NOT reconciled — rotating is a per-component DR step):
put_once argus-postgres-owner-password "$(gen_alnum 32)" # postgres POSTGRES_PASSWORD — rotating breaks migration auth
put_once argus-zitadel-db-password "$(gen_alnum 32)"     # zitadel-db POSTGRES_PASSWORD — rotating breaks Zitadel↔DB auth
put_once argus-glitchtip-db-password "$(gen_alnum 32)"   # glitchtip-db POSTGRES_PASSWORD — rotating breaks GlitchTip↔DB auth
put_once argus-grafana-admin-password "$(gen_alnum 24)"  # GF admin set at first init; rotating has no effect on the live UI
put_once argus-zitadel-masterkey "$(gen_alnum 32)"       # EXACTLY 32 bytes; rotating bricks Zitadel decryption of stored data
# Zitadel bootstrap admin — FirstInstance reads it at first init only (ignored after); change + enable MFA on
# first login. Complexity (upper+lower+digit+symbol) via fixed-class chars appended to an alphanumeric base.
put_once argus-zitadel-admin-password "$(gen_alnum 20)Aa9."

# --- Derived DSNs. Build from the CURRENT password values so they always match the role passwords deploy.sh
#     sets. database_url uses a DEDICATED argus_app password (NOT the redis pw — closes audit infra-4). ---
if [ "$ROTATE" -eq 1 ] || ! secret_exists argus-database-url; then
  put argus-database-url "postgres://argus_app:$(gen_alnum 32)@postgres:5432/argus"
else
  log "exists, skipping argus-database-url"
fi
# Derived from the set-once owner password, so it never needs a rotate-rebuild (the owner never changes here).
if ! secret_exists argus-migration-database-url; then
  _owner="$(get_secret argus-postgres-owner-password)"
  put argus-migration-database-url "postgres://argus:${_owner}@postgres:5432/argus"
  _owner=""
else
  log "exists, skipping argus-migration-database-url (derived from the set-once owner password)"
fi

# --- External credentials. The value comes from the env var if set; otherwise, on an interactive terminal,
#     this PROMPTS for it (hidden — never persisted to a file or shell history; matches invariant #5). Fails
#     closed if a NEW secret is needed but unset with no TTY (e.g. CI). ---
put_external() { # $1 = kv name ; $2 = env var name ; $3 = human prompt
  if [ "$ROTATE" -eq 0 ] && secret_exists "$1"; then
    log "exists, skipping $1"
    return 0
  fi
  local val="${!2:-}"
  if [ -z "$val" ] && [ -t 0 ]; then
    read -rsp "  $3 ($2): " val
    echo
  fi
  [ -n "$val" ] || {
    log "FATAL: $1 needs a value — set \$$2, or run interactively to be prompted"
    exit 1
  }
  set_secret "$1" "$val"
  val=""
}
put_external argus-s3-secret-access-key ARGUS_S3_SECRET_ACCESS_KEY "B2 attachments-bucket secret access key"
put_external argus-b2-app-key ARGUS_B2_APP_KEY "B2 db-backups app key"
put_external argus-tunnel-token ARGUS_TUNNEL_TOKEN "Cloudflare Tunnel token"
put_external argus-ghcr-token ARGUS_GHCR_TOKEN "GitHub read:packages token (GHCR pull)"

log "done. Mandatory secrets present. Arming secrets (stripe/operator/sentry/zitadel-*-pat) are set later."
