#!/usr/bin/env bash
# argus — wire GitHub Actions for the AWS deploy (cd-aws.yml). Reads the Terraform outputs and sets exactly the
# repo VARIABLES cd-aws.yml consumes, the X42C_API_TOKEN secret (if you use 42Crunch), and creates the gated
# GitHub Environment the IAM OIDC trust is bound to. No cloud credentials are stored in GitHub — auth is OIDC.
#
# Auth: `gh auth login` (with repo admin) + `terraform apply` already run in infra/aws/terraform.
# Idempotent: `gh variable/secret set` and the environment PUT all overwrite.
#
# Operator-supplied values via env (no sane default → required): S3_BUCKET, S3_ACCESS_KEY_ID.
# Optional via env: X42C_API_TOKEN (42Crunch), GHCR_USER (default = repo owner), S3_ENDPOINT / S3_REGION
#   (default B2 eu-central-003), B2_CORS_KEY_ID (non-secret keyId for converge-on-deploy attachment CORS — leave
#   unset until you've minted the bucket-restricted CORS key; deploy.sh skips CORS convergence while it's unset),
#   GH_REVIEWER_ID (default = the authenticated gh user), GITHUB_DEPLOY_ENVIRONMENT
#   (default aws-experiment — MUST match var.github_deploy_environment in Terraform).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/../terraform"
log() { printf 'setup-gh: %s\n' "$*"; }
command -v gh >/dev/null || {
  log "FATAL: gh CLI not found"
  exit 1
}
command -v terraform >/dev/null || {
  log "FATAL: terraform not found"
  exit 1
}

tfout() { terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
log "repo: $REPO"

# --- Terraform-derived (authoritative) ---
ROLE_ARN="$(tfout github_deploy_role_arn)"
AWS_REGION="$(tfout aws_region)"
INSTANCE_ID="$(tfout instance_id)"
KEY_VAULT_NAME="$(tfout key_vault_name)"
[ -n "$ROLE_ARN" ] && [ -n "$INSTANCE_ID" ] && [ -n "$KEY_VAULT_NAME" ] || {
  log "FATAL: missing Terraform outputs — run 'terraform -chdir=$TF_DIR apply' first"
  exit 1
}

# --- Operator-supplied (env), with defaults where known ---
GHCR_USER="${GHCR_USER:-${REPO%%/*}}"
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.eu-central-003.backblazeb2.com}"
S3_REGION="${S3_REGION:-eu-central-003}"
DEPLOY_ENV="${GITHUB_DEPLOY_ENVIRONMENT:-aws-experiment}"

# Each value comes from its env var if set; otherwise, on an interactive terminal, PROMPT for it. These are
# non-secret config (bucket / OIDC endpoints) so the prompt echoes — read it back as you type. Fails closed if
# a value is still missing with no TTY (e.g. CI).
prompt_var() { # $1 = var name ; $2 = human prompt
  [ -n "${!1:-}" ] && return 0
  if [ -t 0 ]; then
    local _v
    read -rp "  $2 ($1): " _v
    printf -v "$1" '%s' "$_v"
  fi
  [ -n "${!1:-}" ] || {
    log "FATAL: $1 is required — set it, or run interactively to be prompted"
    exit 1
  }
}
prompt_var S3_BUCKET "B2 attachments bucket name"
prompt_var S3_ACCESS_KEY_ID "B2 attachments key ID (non-secret)"

setvar() {
  gh variable set "$1" --repo "$REPO" --body "$2" >/dev/null
  log "var $1"
}

# --- Repo variables cd-aws.yml reads ---
setvar AWS_DEPLOY_ROLE_ARN "$ROLE_ARN"
setvar AWS_REGION "$AWS_REGION"
setvar AWS_INSTANCE_ID "$INSTANCE_ID"
setvar AWS_KEY_VAULT_NAME "$KEY_VAULT_NAME"
setvar GHCR_USER "$GHCR_USER"
setvar S3_ENDPOINT "$S3_ENDPOINT"
setvar S3_REGION "$S3_REGION"
setvar S3_BUCKET "$S3_BUCKET"
setvar S3_ACCESS_KEY_ID "$S3_ACCESS_KEY_ID" # non-secret (rides in every presigned URL); secret is in Key Vault
# B2 CORS app-key ID — non-secret keyId for converge-on-deploy attachment CORS (the secret half is
# argus-b2-cors-app-key in Key Vault). OPTIONAL: only set once you've minted the bucket-restricted CORS key;
# while the repo var is unset/empty, deploy.sh skips CORS convergence (opt-in, non-breaking).
if [ -n "${B2_CORS_KEY_ID:-}" ]; then
  setvar B2_CORS_KEY_ID "$B2_CORS_KEY_ID"
else
  log "skip B2_CORS_KEY_ID (unset — attachment CORS convergence stays off until provisioned)"
fi
# Master kill-switch OFF until you're ready (flip to true to enable the tag-triggered deploy).
setvar ENABLE_DEPLOY_AWS false

# --- Optional: 42Crunch token (Actions + Dependabot) ---
# A SECRET — prompt hidden when unset on a TTY (blank = skip); honours the env var if already set.
if [ -z "${X42C_API_TOKEN:-}" ] && [ -t 0 ]; then
  read -rsp "  X42C_API_TOKEN (optional 42Crunch token, blank to skip): " X42C_API_TOKEN
  echo
fi
# Set via STDIN — `gh secret set` reads stdin only when --body is OMITTED (a `--body -` would set the literal
# string "-"). STDIN also keeps the token off argv/ps (matches populate-keyvault.sh's hygiene).
if [ -n "${X42C_API_TOKEN:-}" ]; then
  printf '%s' "$X42C_API_TOKEN" | gh secret set X42C_API_TOKEN --repo "$REPO" >/dev/null
  printf '%s' "$X42C_API_TOKEN" | gh secret set X42C_API_TOKEN --repo "$REPO" --app dependabot >/dev/null 2>&1 ||
    log "note: could not set the Dependabot-scoped X42C_API_TOKEN — add it in Settings → Secrets → Dependabot"
  log "secret X42C_API_TOKEN (+ dependabot)"
else
  log "X42C_API_TOKEN not set — skipping (set it + ENABLE_42CRUNCH=true if you want the API audit)"
fi

# --- The gated GitHub Environment (the IAM OIDC subject is bound to repo:OWNER/REPO:environment:<DEPLOY_ENV>) ---
RID="${GH_REVIEWER_ID:-$(gh api user -q .id)}"
gh api -X PUT "repos/$REPO/environments/$DEPLOY_ENV" \
  -f "reviewers[][type]=User" -F "reviewers[][id]=$RID" \
  --silent
log "environment '$DEPLOY_ENV' created with required reviewer (id=$RID)"

log "done. Verify: gh variable list --repo $REPO ; gh api repos/$REPO/environments/$DEPLOY_ENV"
log "ENABLE_DEPLOY_AWS is FALSE — flip it true when ready, then push an aws-vX.Y.Z tag."
