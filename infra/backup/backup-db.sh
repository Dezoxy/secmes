#!/usr/bin/env bash
# argus — nightly logical DB backup worker (VM deploy track, roadmap checkpoint 49). Standalone; runs on
# the VM via a systemd timer (see argus-db-backup.{service,timer}). Each run ships TWO encrypted objects to a
# private EU Backblaze B2 bucket — the cluster ROLES (so a restore onto a fresh cluster has the roles its
# RLS policies/grants reference) and the database itself.
#
# The backup bucket is WORM (B2 Object Lock, Compliance mode — BKP-2): once written, an object cannot be
# deleted or overwritten by anyone (not this key, not the account owner) until its retention expires. So this
# script no longer prunes, and its key intentionally has NO delete capability. Retention/reaping is a
# server-side B2 LIFECYCLE RULE (account-owner-managed, which a compromised host key cannot disable), and a
# lifecycle delete defers to Object Lock — it can never remove a still-locked backup. A partial/corrupt or
# orphaned object is therefore left in place (it is age-ciphertext garbage, leaks nothing); the lifecycle rule
# reaps it after the window, and the restore runbook skips it (size floor + timestamp pairing). See
# infra/b2/README.md (operator runbook) and docs/threat-models/db-backup.md.
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
#   - The DB is reached IN-CONTAINER via `docker compose exec -T postgres pg_dump …` over the container's
#     local socket (PG has NO published host port — invariant #3). The official image trusts local-socket
#     connections, so the worker assumes `argus_backup` with NO password; its read-only/BYPASSRLS scope
#     (above) bounds the connection regardless of auth method — so there is NO DB password on the host at all.
#   - The B2 secret key is read from a FILE delivered by systemd LoadCredential, populated from Azure Key
#     Vault via the VM's Managed Identity — never committed, never in env at rest (invariant #5): the script
#     writes an AWS credentials file in a private tmpfs dir (0600) and points `aws` at it by PATH — the secret
#     VALUE never enters the process environment (so not in /proc/<pid>/environ, not inherited) nor argv/`ps`.
#   - Logs object keys / sizes / counts ONLY — never a secret, never a presigned URL, never plaintext.
#
# Requires: docker compose (reaches the postgres container; `argus` is in the docker group), age
# (https://age-encryption.org — asymmetric file encryption; the host holds only the public key), aws (AWS CLI
# v2, against the B2 S3 endpoint), GNU date. pg_dump/pg_dumpall run INSIDE the postgres container.
set -euo pipefail

# --- Non-secret config (provided by the systemd unit's Environment=). No PGHOST/PGPORT/PGPASSFILE: the DB is
#     reached in-container via `docker compose exec` (below), not over a host TCP port (invariant #3). ---
: "${PGUSER:?PGUSER required (argus_backup)}"
: "${PGDATABASE:?PGDATABASE required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required (the PRIVATE db-backup bucket)}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
# The age recipient is a PUBLIC key (age1...). REQUIRED — refuse to run without it, so a dump can NEVER be
# uploaded in the clear by misconfiguration.
: "${AGE_RECIPIENT:?AGE_RECIPIENT required (age public key) — refusing to upload an unencrypted dump}"

export AWS_REGION="${S3_REGION:-eu-central-003}" # EU default (B2 ignores it for routing; the host carries it)

# Run a Postgres client INSIDE the running postgres container — PG has no published port (invariant #3), and
# the official image trusts local-socket connections, so `-U "$PGUSER"` (argus_backup) assumes the
# least-privilege role with NO password. `-T` keeps stdout a clean binary stream for the custom-format dump.
# COMPOSE_FILE + COMPOSE_PROJECT_NAME (set by the unit) attach to the deployed stack regardless of cwd. The
# in-container exit code propagates through `exec -T`, so the dump_upload PIPESTATUS checks still hold.
pgx() { docker compose exec -T postgres "$@"; }

# No RETENTION_DAYS knob: retention is enforced by the bucket (Object Lock default retention) and old objects
# are reaped by a B2 lifecycle rule, NOT by this script — the backup key has no delete capability (BKP-2).
BACKUP_PREFIX="${BACKUP_PREFIX:-argus}" # common root → both objects share it so the lifecycle rule (prefix
# argus-) covers both families with one rule

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
# Put the secret files under the systemd RuntimeDirectory ($RUNTIME_DIRECTORY) — a service-private tmpfs with
# NO host-disk backing — rather than /tmp. (PrivateTmp=true isolates /tmp but its boolean form still backs
# onto the host /tmp, so a crash/power-loss could leave the materialised secrets on disk.) Fall back to
# TMPDIR/tmp for a local dry-run. mktemp makes the dir 0700; the trap removes it on exit.
secbase="${RUNTIME_DIRECTORY:-}"
secbase="${secbase%%:*}" # first path if systemd gave a colon-separated list
WORKDIR="$(mktemp -d "${secbase:-${TMPDIR:-/tmp}}/argus-db-backup.XXXXXXXX")"
trap 'rm -rf -- "$WORKDIR"' EXIT

# No libpq passfile: the DB connection runs in-container over the local-trust socket (see pgx() above), so no
# DB password is materialised on the host at all.

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
# Returns non-zero on failure so the caller can abort. It does NOT delete a partial/too-small object: under
# Object Lock the key cannot delete, and a leftover is age-ciphertext that the lifecycle rule reaps and the
# restore runbook skips (size floor + timestamp pairing) — see the header.
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
    # WORM bucket: we cannot delete a partial upload (no delete capability, and a finalized object is locked).
    # Leave it — it is age-ciphertext, reaped by the lifecycle rule and skipped at restore (size floor). The
    # non-zero return still aborts the run and fires the OnFailure alert.
    log "FAILED ${label} (gen=${p[0]} age=${p[1]} aws=${p[2]}) — partial object ${key} left for the B2 lifecycle rule (WORM: not deletable here)"
    return 1
  fi

  # head-object can emit a NON-numeric value ('None'/empty on a transient error); guard the arithmetic so a
  # bare `[[ "None" -lt N ]]` under `set -e` can't abort and mislabel a GOOD backup as failed.
  local size
  size="$(aws s3api head-object --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$key" \
    --query 'ContentLength' --output text 2>/dev/null || true)"
  if [[ "$size" =~ ^[0-9]+$ ]]; then
    if [[ "$size" -lt "$floor" ]]; then
      # Suspected-broken dump. WORM: cannot delete it here; the restore runbook applies the SAME size floor and
      # skips it (walks to the next-older good object), and the lifecycle rule reaps it after the window.
      log "FAILED ${label} object too small (${size} < ${floor} bytes) — suspected-broken dump ${key} left for the B2 lifecycle rule (WORM); restore skips it by the same size floor"
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
  pgx pg_dumpall -U "$PGUSER" --database="$PGDATABASE" --no-password --roles-only --no-role-passwords || exit 1

# 2) The database (custom format → compact, supports selective/parallel restore). A run is ALL-OR-NOTHING in
#    INTENT: if the DB dump fails after the roles object uploaded, that roles object is now orphaned. Under
#    WORM we cannot delete it (no delete capability, and it is locked), so we leave it and exit non-zero. The
#    orphan is HARMLESS at restore: the restore runbook pairs from the DB side — it picks the latest valid
#    `argus-db-*` and fetches the `argus-globals-*` with the SAME stamp — so an orphan globals with no matching
#    db is never selected. The lifecycle rule reaps it after the window.
if ! dump_upload "db dump" "$db_key" 1024 -- \
  pgx pg_dump -U "$PGUSER" --format=custom --no-password "$PGDATABASE"; then
  log "db dump failed — roles object ${globals_key} is now orphaned; left in place (WORM: not deletable). Harmless: restore pairs from the db side by stamp, so an unpaired globals is never selected. Reaped by the lifecycle rule."
  exit 1
fi

# Retention/reaping is NOT done here. The bucket is WORM (Object Lock) and the backup key has no delete
# capability (BKP-2), so old objects are removed by a server-side B2 LIFECYCLE RULE (prefix argus-, ~35d),
# which a compromised host key cannot disable and which defers to Object Lock (it can never remove a
# still-locked backup). See infra/b2/README.md for the rule + the operator runbook.
log "done globals=${globals_key} db=${db_key} (retention: B2 Object Lock + lifecycle rule, not script prune)"
