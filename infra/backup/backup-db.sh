#!/usr/bin/env bash
# argus — nightly logical DB backup worker (VM deploy track, roadmap checkpoint 49). Standalone; runs on
# the VM via a systemd timer (see argus-db-backup.{service,timer}). Streams a `pg_dump` of the whole
# database, encrypts it CLIENT-SIDE, and ships it to a private EU Backblaze B2 bucket — then prunes backups
# past the retention window.
#
# Security model:
#   - Connects to Postgres as the least-privilege `argus_backup` role (migration 0015): READ-ONLY across all
#     tenants (pg_read_all_data + BYPASSRLS so FORCE-RLS tables dump fully), never able to write or DROP.
#   - CLIENT-SIDE ENCRYPTION: the dump is encrypted with `age` to a PUBLIC recipient key BEFORE it leaves the
#     box, so B2 only ever stores ciphertext (invariant #2 — the DB holds cleartext METADATA: emails, names,
#     membership; message bodies are already MLS ciphertext). The age PRIVATE key is NOT on the VM — it lives
#     in Key Vault and is fetched only at RESTORE time, so a compromised backup host cannot read past dumps.
#   - Secrets (DB password, B2 secret key) are read from FILES delivered by systemd LoadCredential, populated
#     from Azure Key Vault via the VM's Managed Identity — never committed, never in env at rest (invariant
#     #5). libpq PG* env (no connstring on argv) keeps the password out of `ps`/argv.
#   - Logs object keys / sizes / counts ONLY — never a secret, never a presigned URL, never plaintext.
#
# Requires: pg_dump (libpq client), age (https://age-encryption.org — asymmetric file encryption; the host
# holds only the public key), aws (AWS CLI v2, used against the B2 S3-compatible endpoint), GNU date.
set -euo pipefail

# --- Non-secret config (provided by the systemd unit's Environment=). ---
: "${PGHOST:?PGHOST required}"
: "${PGUSER:?PGUSER required (argus_backup)}"
: "${PGDATABASE:?PGDATABASE required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required (the PRIVATE db-backup bucket)}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
# The age recipient is a PUBLIC key (age1...). REQUIRED — refuse to run without it, so a dump can NEVER be
# uploaded in the clear by misconfiguration.
: "${AGE_RECIPIENT:?AGE_RECIPIENT required (age public key) — refusing to upload an unencrypted dump}"

export PGHOST PGUSER PGDATABASE
export PGPORT="${PGPORT:-5432}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
export AWS_REGION="${S3_REGION:-eu-central-003}" # EU default (B2 ignores it for routing; the host carries it)
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_PREFIX="${BACKUP_PREFIX:-argus-db}"

# --- Secrets from credential files (systemd LoadCredential / Key Vault). Trim the trailing newline. ---
read_secret_file() {
  local f="$1"
  [[ -r "$f" ]] || {
    echo "backup: secret file not readable: $f" >&2
    exit 1
  }
  tr -d '\n' <"$f"
}
PGPASSWORD="$(read_secret_file "${BACKUP_DB_PASSWORD_FILE:?BACKUP_DB_PASSWORD_FILE required}")"
export PGPASSWORD
AWS_SECRET_ACCESS_KEY="$(read_secret_file "${S3_SECRET_ACCESS_KEY_FILE:?S3_SECRET_ACCESS_KEY_FILE required}")"
export AWS_SECRET_ACCESS_KEY

log() { printf '[%s] backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="${BACKUP_PREFIX}-${stamp}.dump.age"
s3_uri="s3://${S3_BUCKET}/${key}"

log "starting pg_dump → age → ${s3_uri}"

# Stream dump → encrypt → upload in one pipeline (no plaintext dump ever touches disk). PIPESTATUS captures
# each stage's exit code: a mid-stream pg_dump failure still yields a valid-but-TRUNCATED age object, so we
# must detect it and delete the partial upload rather than keep a corrupt backup.
set +e
pg_dump --format=custom --no-password "$PGDATABASE" \
  | age -r "$AGE_RECIPIENT" \
  | aws s3 cp - "$s3_uri" --endpoint-url "$S3_ENDPOINT" --only-show-errors
pipe=("${PIPESTATUS[@]}")
set -e

if [[ "${pipe[0]}" -ne 0 || "${pipe[1]}" -ne 0 || "${pipe[2]}" -ne 0 ]]; then
  log "FAILED (pg_dump=${pipe[0]} age=${pipe[1]} aws=${pipe[2]}) — deleting any partial upload"
  aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1 || true
  exit 1
fi

# Verify the object landed and is non-trivially sized. A real argus dump — schema + at least the
# seed/tenants — is comfortably over this floor; a custom-format dump is never sub-1KiB.
# head-object can emit a NON-numeric value ('None', or nothing on a transient error), so guard the
# arithmetic: a bare `[[ "None" -lt 1024 ]]` under `set -e` would abort and report a GOOD backup as failed.
size="$(aws s3api head-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" \
  --query 'ContentLength' --output text 2>/dev/null || true)"
if [[ "$size" =~ ^[0-9]+$ ]]; then
  if [[ "$size" -lt 1024 ]]; then
    # Verified tiny → a broken dump. Delete it and FAIL, so the unit's non-zero exit pages instead of
    # silently "succeeding" with a worthless backup (the worst DR outcome).
    log "FAILED uploaded object is too small (${size} bytes) — deleting suspected-broken dump: ${key}"
    aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1 || true
    exit 1
  fi
  log "uploaded ${key} (${size} bytes, encrypted)"
else
  # No numeric size (transient head-object error). The upload pipeline already succeeded (PIPESTATUS all
  # zero), so KEEP the object — just flag that the size couldn't be verified (never a false failure here).
  log "WARNING uploaded ${key} but could not verify size (head-object returned '${size:-}') — kept"
fi

# --- Retention prune. Day-granular (perfect for a daily timer): delete backups whose date is older than the
#     cutoff. ISO-8601 date strings compare lexically, so no per-object date parsing. The just-written object
#     (today) is always newer than the cutoff, so it is never pruned. ---
cutoff_date="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%d)"
pruned=0
while IFS=$'\t' read -r okey lastmodified; do
  [[ -n "$okey" ]] || continue
  [[ "${lastmodified:0:10}" < "$cutoff_date" ]] || continue
  if aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$okey" >/dev/null 2>&1; then
    pruned=$((pruned + 1))
    log "pruned old backup ${okey} (modified ${lastmodified:0:10}, cutoff ${cutoff_date})"
  else
    log "prune failed for ${okey} (kept; retries next run)"
  fi
done < <(
  aws s3api list-objects-v2 --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --prefix "$BACKUP_PREFIX" \
    --query 'Contents[].[Key,LastModified]' --output text 2>/dev/null || true
)

log "done key=${key} size=${size} pruned=${pruned} retention_days=${RETENTION_DAYS}"
