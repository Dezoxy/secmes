#!/usr/bin/env bash
# argus — expired-attachment cleanup worker (roadmap checkpoint 37). Standalone; runs on the VM via a
# systemd timer (see argus-attachment-cleanup.{service,timer}). Reaps EXPIRED encrypted attachment blobs
# (Backblaze B2) + their metadata rows after the retention window (expires_at, set 7 days out at upload).
#
# Security model:
#   - Connects to Postgres as the least-privilege `argus_cleanup` role, whose RLS policy (migration 0013)
#     exposes ONLY rows whose retention has lapsed — never a live row, never any other tenant data.
#   - Deletes the B2 OBJECT FIRST, then the DB row: a crash leaves the row for the next run (idempotent),
#     never an orphan blob. S3/B2 DeleteObject is idempotent (deleting a missing key still succeeds).
#   - Secrets (DB password, B2 application key) are read from FILES delivered by systemd LoadCredential,
#     populated from Azure Key Vault via the VM's Managed Identity — never committed, never in env at rest
#     (invariant #5). The DB connection uses libpq PG* env vars (no connstring on argv), so the password
#     never appears in `ps`/argv.
#   - Logs IDs / object-keys / counts ONLY — never a secret (invariant #2). There are no presigned URLs here.
#
# Requires: psql (libpq), aws (AWS CLI v2, used against the B2 S3-compatible endpoint).
set -euo pipefail

BATCH="${CLEANUP_BATCH:-1000}"

# --- Non-secret config (libpq + S3). Provided by the systemd unit's Environment=. ---
: "${PGHOST:?PGHOST required}"
: "${PGUSER:?PGUSER required (argus_cleanup)}"
: "${PGDATABASE:?PGDATABASE required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
export PGHOST PGUSER PGDATABASE
export PGPORT="${PGPORT:-5432}"
export AWS_REGION="${S3_REGION:-eu-central-003}" # EU default (B2 ignores it for routing; the host carries it)
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"

# --- Secrets from credential files (systemd LoadCredential / Key Vault). Trim the trailing newline. ---
read_secret_file() {
  local f="$1"
  [[ -r "$f" ]] || {
    echo "cleanup: secret file not readable: $f" >&2
    exit 1
  }
  tr -d '\n' <"$f"
}
PGPASSWORD="$(read_secret_file "${CLEANUP_DB_PASSWORD_FILE:?CLEANUP_DB_PASSWORD_FILE required}")"
export PGPASSWORD
AWS_SECRET_ACCESS_KEY="$(read_secret_file "${S3_SECRET_ACCESS_KEY_FILE:?S3_SECRET_ACCESS_KEY_FILE required}")"
export AWS_SECRET_ACCESS_KEY

log() { printf '[%s] cleanup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

total_reaped=0
total_failed=0
rounds=0

# Drain expired rows in batches. Terminates on: no rows left, a batch with zero progress (e.g. B2
# unreachable — avoids spinning on the same rows), or a safety round cap.
while :; do
  rounds=$((rounds + 1))
  # The argus_cleanup RLS policy already restricts visibility to expired rows; the explicit predicate +
  # ORDER/LIMIT just bound the batch deterministically. Output: id<TAB>object_key per line. A failed query
  # (DB blip) is a logged no-op + stop — never a crash mid-batch, never a truncated partial read.
  if ! rows="$(psql -At -F $'\t' -c \
    "select id, object_key from attachments
     where expires_at is not null and expires_at < now() order by expires_at limit ${BATCH}")"; then
    log "batch query failed (DB unreachable?) — stopping; retries next run"
    break
  fi
  [[ -z "$rows" ]] && break

  batch_reaped=0
  while IFS=$'\t' read -r id object_key; do
    [[ -n "$id" ]] || continue
    # 1) delete the B2 object FIRST (idempotent — a missing key still returns success).
    if aws s3api delete-object \
      --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$object_key" >/dev/null 2>&1; then
      # 2) then delete the metadata row (psql quotes :'id' — no injection; still RLS-gated to expired rows).
      if psql -q -v id="$id" -c "delete from attachments where id = :'id'" >/dev/null 2>&1; then
        batch_reaped=$((batch_reaped + 1))
      else
        total_failed=$((total_failed + 1))
        log "row delete failed id=${id} (blob already removed; retries next run)"
      fi
    else
      total_failed=$((total_failed + 1))
      log "blob delete failed key=${object_key} (row kept; retries next run)"
    fi
  done <<<"$rows"

  total_reaped=$((total_reaped + batch_reaped))
  [[ "$batch_reaped" -eq 0 ]] && {
    log "batch made no progress — stopping (will retry on the next timer run)"
    break
  }
  [[ "$rounds" -ge "${CLEANUP_MAX_ROUNDS:-50}" ]] && {
    log "hit max rounds cap (${CLEANUP_MAX_ROUNDS:-50}) — stopping"
    break
  }
done

log "done reaped=${total_reaped} failed=${total_failed} rounds=${rounds}"
