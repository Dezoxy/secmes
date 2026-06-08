#!/usr/bin/env bash
# argus — nightly logical DB backup worker (VM deploy track, roadmap checkpoint 49). Standalone; runs on
# the VM via a systemd timer (see argus-db-backup.{service,timer}). Each run ships TWO encrypted objects to a
# private EU Backblaze B2 bucket — the cluster ROLES (so a restore onto a fresh cluster has the roles its
# RLS policies/grants reference) and the database itself — then prunes backups past the retention window.
#
# Security model:
#   - Connects to Postgres as the least-privilege `argus_backup` role (migration 0015): READ-ONLY across all
#     tenants (pg_read_all_data + BYPASSRLS so FORCE-RLS tables dump fully), never able to write or DROP.
#   - The roles dump uses `--no-role-passwords`, so the backup carries role DEFINITIONS (attributes +
#     memberships) but NOT password hashes — passwords are re-applied from Key Vault at restore (invariant
#     #2/#5: no credential material in the backup). `--no-role-passwords` also avoids needing pg_authid, so a
#     non-superuser can produce it.
#   - CLIENT-SIDE ENCRYPTION: every object is encrypted with `age` to a PUBLIC recipient key BEFORE it leaves
#     the box, so B2 only ever stores ciphertext (the DB holds cleartext METADATA: emails, names, membership;
#     message bodies are already MLS ciphertext). The age PRIVATE key is NOT on the VM — it lives in Key Vault
#     and is fetched only at RESTORE time, so a compromised backup host cannot read past dumps.
#   - Secrets (DB password, B2 secret key) are read from FILES delivered by systemd LoadCredential, populated
#     from Azure Key Vault via the VM's Managed Identity — never committed, never in env at rest (invariant
#     #5). They stay FILE-BACKED end-to-end: the script writes a libpq passfile + an AWS credentials file in a
#     private tmpfs dir (0600) and points the CLIs at them by PATH — the secret VALUES never enter the process
#     environment (so they're not in /proc/<pid>/environ, not inherited by children) nor argv/`ps`.
#   - Logs object keys / sizes / counts ONLY — never a secret, never a presigned URL, never plaintext.
#
# Requires: pg_dump + pg_dumpall (libpq client), age (https://age-encryption.org — asymmetric file
# encryption; the host holds only the public key), aws (AWS CLI v2, against the B2 S3 endpoint), GNU date.
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

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_PREFIX="${BACKUP_PREFIX:-argus}" # common root → both objects share it so one prune covers them

read_secret_file() {
  local f="$1"
  [[ -r "$f" ]] || {
    echo "backup: secret file not readable: $f" >&2
    exit 1
  }
  tr -d '\n' <"$f"
}

# --- Secrets stay FILE-BACKED end-to-end. We do NOT `export PGPASSWORD` / `AWS_SECRET_ACCESS_KEY`: an
#     exported secret is readable via /proc/<pid>/environ (root + same-UID) and is inherited by EVERY child,
#     including the ones that don't need it (`age`, `aws` don't need the DB password; `pg_dump` doesn't need
#     the B2 secret). Instead we materialise a libpq passfile + an AWS credentials file in a private tmpfs
#     work dir (0600) and point the CLIs at them by PATH — so no secret VALUE ever enters the environment
#     (invariant #5: secret delivered as a file, end-to-end). The source secrets arrive via systemd
#     LoadCredential (Key Vault). The work dir is removed on exit. ---
umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf -- "$WORKDIR"' EXIT
chmod 700 "$WORKDIR"

# libpq passfile (hostname:port:database:username:password). Wildcards are safe in a private 0600 file used
# only by this unit. The password's `\` and `:` are escaped per the .pgpass format.
_db_pw="$(read_secret_file "${BACKUP_DB_PASSWORD_FILE:?BACKUP_DB_PASSWORD_FILE required}")"
_esc_pw="$(printf '%s' "$_db_pw" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g')"
PGPASSFILE="$WORKDIR/pgpass"
printf '*:*:*:%s:%s\n' "$PGUSER" "$_esc_pw" >"$PGPASSFILE"
chmod 600 "$PGPASSFILE"
export PGPASSFILE
unset _db_pw _esc_pw

# AWS shared-credentials file. The access-key-id is NOT a secret; the secret key rides only in this 0600 file.
AWS_SHARED_CREDENTIALS_FILE="$WORKDIR/aws-credentials"
{
  printf '[default]\n'
  printf 'aws_access_key_id = %s\n' "$S3_ACCESS_KEY_ID"
  printf 'aws_secret_access_key = %s\n' \
    "$(read_secret_file "${S3_SECRET_ACCESS_KEY_FILE:?S3_SECRET_ACCESS_KEY_FILE required}")"
} >"$AWS_SHARED_CREDENTIALS_FILE"
chmod 600 "$AWS_SHARED_CREDENTIALS_FILE"
export AWS_SHARED_CREDENTIALS_FILE

log() { printf '[%s] backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# dump_upload <label> <key> <min_bytes> -- <generator cmd...>
# Streams `<cmd> | age | aws s3 cp -` (no plaintext on disk). Verifies via PIPESTATUS + a size floor.
# Returns non-zero (after deleting any partial/too-small object) on failure, so the caller can abort.
dump_upload() {
  local label="$1" key="$2" floor="$3"
  shift 4 # drop label, key, floor, and the literal "--" separator
  local uri="s3://${S3_BUCKET}/${key}"
  log "starting ${label} → ${uri}"

  set +e
  "$@" | age -r "$AGE_RECIPIENT" | aws s3 cp - "$uri" --endpoint-url "$S3_ENDPOINT" --only-show-errors
  local p=("${PIPESTATUS[@]}")
  set -e

  if [[ "${p[0]}" -ne 0 || "${p[1]}" -ne 0 || "${p[2]}" -ne 0 ]]; then
    log "FAILED ${label} (gen=${p[0]} age=${p[1]} aws=${p[2]}) — deleting any partial upload ${key}"
    aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1 || true
    return 1
  fi

  # head-object can emit a NON-numeric value ('None'/empty on a transient error); guard the arithmetic so a
  # bare `[[ "None" -lt N ]]` under `set -e` can't abort and mislabel a GOOD backup as failed.
  local size
  size="$(aws s3api head-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" \
    --query 'ContentLength' --output text 2>/dev/null || true)"
  if [[ "$size" =~ ^[0-9]+$ ]]; then
    if [[ "$size" -lt "$floor" ]]; then
      log "FAILED ${label} object too small (${size} < ${floor} bytes) — deleting suspected-broken dump: ${key}"
      aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1 || true
      return 1
    fi
    log "uploaded ${key} (${size} bytes, encrypted)"
  else
    log "WARNING uploaded ${key} but could not verify size (head-object returned '${size:-}') — kept"
  fi
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
globals_key="${BACKUP_PREFIX}-globals-${stamp}.sql.age"
db_key="${BACKUP_PREFIX}-db-${stamp}.dump.age"

# 1) Cluster ROLES first (tiny). Definitions + memberships, NO passwords. Without this a restore onto a fresh
#    cluster fails: the schema's role-scoped RLS policies + grants reference argus_app/argus_cleanup/etc.
dump_upload "roles (globals)" "$globals_key" 64 -- \
  pg_dumpall --database="$PGDATABASE" --no-password --roles-only --no-role-passwords || exit 1

# 2) The database (custom format → compact, supports selective/parallel restore). A run is ALL-OR-NOTHING:
#    if the DB dump fails, delete the roles object we just wrote so no orphaned `globals` is left to be paired
#    with an OLDER db at restore (which, after a role/grant-affecting migration, would restore mismatched
#    ACL/policy state). Either both of this run's objects land, or neither.
if ! dump_upload "db dump" "$db_key" 1024 -- \
  pg_dump --format=custom --no-password "$PGDATABASE"; then
  log "db dump failed — removing the now-orphaned roles object ${globals_key} (keep the run atomic)"
  aws s3api delete-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$globals_key" >/dev/null 2>&1 || true
  exit 1
fi

# --- Retention prune. Day-granular (perfect for a daily timer): delete backups whose date is older than the
#     cutoff. One list under the shared prefix covers BOTH object families. ISO-8601 date strings compare
#     lexically, so no per-object date parsing. The just-written objects (today) are never older than the
#     cutoff, so they are never pruned. ---
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
  aws s3api list-objects-v2 --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --prefix "${BACKUP_PREFIX}-" \
    --query 'Contents[].[Key,LastModified]' --output text 2>/dev/null || true
)

log "done globals=${globals_key} db=${db_key} pruned=${pruned} retention_days=${RETENTION_DAYS}"
