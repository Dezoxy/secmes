#!/usr/bin/env bash
# argus — one-time bootstrap of the remote Terraform state backend for the REAL AWS deploy: a versioned,
# encrypted, public-blocked S3 bucket + a DynamoDB lock table. Created with the AWS CLI (NOT Terraform) to
# avoid the chicken-and-egg of "Terraform needs the backend that Terraform would create". Idempotent.
#
# After this runs, uncomment the `backend "s3"` block in versions.tf and:
#   terraform -chdir=infra/aws/terraform init -backend-config=backend.hcl -migrate-state
#
# Auth: `aws configure` / SSO with rights to create the bucket + table (run from your laptop, once).
# Env (all optional): BUCKET (default argus-tfstate-<account-id>), TABLE (default argus-tflock),
#   AWS_REGION (default eu-central-1, EU residency).
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
TABLE="${TABLE:-argus-tflock}"
log() { printf 'tfstate-bootstrap: %s\n' "$*"; }
command -v aws >/dev/null || {
  log "FATAL: aws CLI not found"
  exit 1
}

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-argus-tfstate-${ACCOUNT}}"
log "region=$REGION  bucket=$BUCKET  table=$TABLE"

# --- S3 bucket (idempotent: skip create if it already exists) ---
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "bucket exists: $BUCKET"
else
  # us-east-1 must NOT pass a LocationConstraint; every other region must.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  log "created bucket $BUCKET"
fi

# Harden the bucket: versioning (state history / recovery), default SSE, block ALL public access.
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled >/dev/null
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' >/dev/null
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
log "bucket hardened (versioning + AES256 + public-access blocked)"

# --- DynamoDB lock table (idempotent) ---
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  log "lock table exists: $TABLE"
else
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
  log "created lock table $TABLE"
fi

# --- Emit backend.hcl for `terraform init -backend-config=backend.hcl` (gitignored; no secrets in it) ---
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../terraform" && pwd)/backend.hcl"
cat >"$BACKEND" <<EOF
bucket         = "$BUCKET"
key            = "aws-real.tfstate"
region         = "$REGION"
dynamodb_table = "$TABLE"
encrypt        = true
EOF
log "wrote $BACKEND"
log "next: uncomment backend \"s3\" {} in versions.tf, then:"
log "  terraform -chdir=infra/aws/terraform init -backend-config=backend.hcl -migrate-state"
