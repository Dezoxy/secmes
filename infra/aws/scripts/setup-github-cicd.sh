#!/usr/bin/env bash
# argus — wire GitHub Actions for the AWS deploy (cd-aws.yml). Reads the Terraform outputs and sets exactly the
# repo VARIABLES cd-aws.yml consumes, the X42C_API_TOKEN secret (if you use 42Crunch), and creates the gated
# GitHub Environment the IAM OIDC trust is bound to. No cloud credentials are stored in GitHub — auth is OIDC.
#
# Auth: `gh auth login` (with repo admin) + `terraform apply` already run in infra/aws/terraform.
# Idempotent: `gh variable/secret set` and the environment PUT all overwrite.
#
# Operator-supplied values via env (no sane default → required): S3_BUCKET, S3_ACCESS_KEY_ID, OIDC_ISSUER,
#   OIDC_AUDIENCE, VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, VITE_OIDC_REDIRECT_URI.
# Optional via env: X42C_API_TOKEN (42Crunch), GHCR_USER (default = repo owner), S3_ENDPOINT / S3_REGION
#   (default B2 eu-central-003), GH_REVIEWER_ID (default = the authenticated gh user), GITHUB_DEPLOY_ENVIRONMENT
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

missing=()
for v in S3_BUCKET S3_ACCESS_KEY_ID OIDC_ISSUER OIDC_AUDIENCE VITE_OIDC_ISSUER VITE_OIDC_CLIENT_ID VITE_OIDC_REDIRECT_URI; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "FATAL: set these env vars first: ${missing[*]}"
  exit 1
fi

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
setvar OIDC_ISSUER "$OIDC_ISSUER"
setvar OIDC_AUDIENCE "$OIDC_AUDIENCE"
setvar VITE_OIDC_ISSUER "$VITE_OIDC_ISSUER"
setvar VITE_OIDC_CLIENT_ID "$VITE_OIDC_CLIENT_ID"
setvar VITE_OIDC_REDIRECT_URI "$VITE_OIDC_REDIRECT_URI"
# Master kill-switch OFF until you're ready (flip to true to enable the tag-triggered deploy).
setvar ENABLE_DEPLOY_AWS false

# --- Optional: 42Crunch token (Actions + Dependabot) ---
# Read the value from STDIN — `gh secret set` reads stdin only when --body is OMITTED (a `--body -` would set
# the literal string "-"). STDIN also keeps the token off argv/ps (matches populate-keyvault.sh's hygiene).
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
