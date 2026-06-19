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
#   - The DB is reached IN-CONTAINER via `docker compose exec -T postgres psql …` over the container's local
#     socket (PG has NO published host port — invariant #3). The official image trusts local connections, so
#     the worker assumes `argus_cleanup` with NO password; its RLS policy (which exposes only expired rows)
#     bounds it regardless of auth method — so there is NO DB password on the host at all.
#   - The B2 application key is read from a FILE delivered by systemd LoadCredential, populated from Azure Key
#     Vault via the VM's Managed Identity — never committed, never in env at rest (invariant #5).
#   - Logs IDs / object-keys / counts ONLY — never a secret (invariant #2). There are no presigned URLs here.
#
# Requires: docker compose (reaches the postgres container; `argus` is in the docker group), aws (AWS CLI v2,
# used against the B2 S3-compatible endpoint). psql runs INSIDE the postgres container.
set -euo pipefail

BATCH="${CLEANUP_BATCH:-1000}"

# --- Non-secret config. Provided by the systemd unit's Environment=. No PGHOST/PGPORT/PGPASSFILE: the DB is
#     reached in-container via `docker compose exec` (below), not over a host TCP port (invariant #3). ---
: "${PGUSER:?PGUSER required (argus_cleanup)}"
: "${PGDATABASE:?PGDATABASE required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID required}"
export AWS_REGION="${S3_REGION:-eu-central-003}" # EU default (B2 ignores it for routing; the host carries it)

# Run psql INSIDE the running postgres container — PG has no published port (invariant #3), and the official
# image trusts local-socket connections, so `-U "$PGUSER"` (argus_cleanup) assumes the least-privilege role
# with NO password. Its RLS policy still exposes only expired rows. COMPOSE_FILE + COMPOSE_PROJECT_NAME (set
# by the unit) attach to the deployed stack; `-T` forwards stdin (for the heredoc'd DELETE) without a TTY.
pgx() { docker compose exec -T postgres "$@"; }

# --- Secrets stay FILE-BACKED end-to-end. We do NOT `export PGPASSWORD` / `AWS_SECRET_ACCESS_KEY`: an
#     exported secret is readable via /proc/<pid>/environ (root + same-UID) and is inherited by EVERY child
#     (psql doesn't need the B2 secret; aws doesn't need the DB password). Instead we materialise a libpq
#     passfile + an AWS credentials file in a private tmpfs work dir (0600) and point the CLIs at them by
#     PATH — so no secret VALUE ever enters the environment (invariant #5). The source secrets arrive via
#     systemd LoadCredential (Key Vault). The work dir is removed on exit. Mirrors infra/backup/backup-db.sh. ---
read_secret_file() {
  local f="$1"
  [[ -r "$f" ]] || {
    echo "cleanup: secret file not readable: $f" >&2
    exit 1
  }
  tr -d '\n' <"$f"
}

umask 077
# Put the secret files under the systemd RuntimeDirectory ($RUNTIME_DIRECTORY) — a service-private tmpfs with
# NO host-disk backing — rather than /tmp. Fall back to TMPDIR/tmp for a local dry-run. mktemp makes the dir
# 0700; the trap removes it on exit.
secbase="${RUNTIME_DIRECTORY:-}"
secbase="${secbase%%:*}" # first path if systemd gave a colon-separated list
WORKDIR="$(mktemp -d "${secbase:-${TMPDIR:-/tmp}}/argus-cleanup.XXXXXXXX")"
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

log() { printf '[%s] cleanup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

total_reaped=0
total_failed=0
rounds=0
db_unreachable=0
stalled=0

# Drain expired rows in batches. Terminates on: no rows left, a batch with zero progress (e.g. B2
# unreachable — avoids spinning on the same rows), or a safety round cap.
while :; do
  rounds=$((rounds + 1))
  # The argus_cleanup RLS policy already restricts visibility to expired rows; the explicit predicate +
  # ORDER/LIMIT just bound the batch deterministically. Output: id<TAB>object_key per line. A failed query
  # (DB blip) is a logged no-op + stop — never a crash mid-batch, never a truncated partial read.
  if ! rows="$(pgx psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -At -F $'\t' -c \
    "select id, object_key from attachments
     where expires_at is not null and expires_at < now() order by expires_at limit ${BATCH}")"; then
    # DB unreachable / query error: stop and FAIL the unit (non-zero exit below) so OnFailure= alerts —
    # a cleanup that can't reach the DB must not report success. The timer still retries next run.
    log "batch query failed (DB unreachable?) — stopping; will fail the unit so OnFailure alerts"
    db_unreachable=1
    break
  fi
  [[ -z "$rows" ]] && break

  batch_reaped=0
  while IFS=$'\t' read -r id object_key; do
    [[ -n "$id" ]] || continue
    # 1) delete the B2 object FIRST (idempotent — a missing key still returns success).
    if aws s3api delete-object \
      --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --key "$object_key" >/dev/null 2>&1; then
      # 2) then delete the metadata row. NOTE: `psql -c` does NOT expand psql vars (`:'id'`), so the SQL is
      # fed via STDIN, where the lexer interpolates the quoted `:'id'` (no injection; still RLS-gated).
      # ON_ERROR_STOP=1 so a SQL error EXITS non-zero (psql otherwise exits 0 on errors → false success).
      if printf '%s' "delete from attachments where id = :'id'" |
        pgx psql -U "$PGUSER" -d "$PGDATABASE" -q -v ON_ERROR_STOP=1 -v id="$id" >/dev/null 2>&1; then
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
    # Rows were due for reaping but NONE succeeded — every delete in the batch failed (B2 unreachable, no
    # deleteFiles permission on the attachment key, or a persistent error). Stop and FAIL the unit so
    # OnFailure= alerts; the timer retries next run. A healthy run reaps > 0 and never reaches this.
    log "batch made no progress despite expired rows — stopping; will fail the unit so OnFailure alerts"
    stalled=1
    break
  }
  [[ "$rounds" -ge "${CLEANUP_MAX_ROUNDS:-50}" ]] && {
    log "hit max rounds cap (${CLEANUP_MAX_ROUNDS:-50}) — stopping"
    break
  }
done

log "done reaped=${total_reaped} failed=${total_failed} rounds=${rounds}"
# Fail the unit (so OnFailure= alerts) if we couldn't reach the DB, or a batch fully stalled despite having
# expired rows to reap (B2 unreachable / missing deleteFiles / persistent error) — a silent exit-0 on those
# is exactly the kind of gap BKP-1 was about. Per-item blob/row failures (total_failed) are transient and
# retried next run, so they alone don't fail the unit.
if [ "$db_unreachable" = 1 ] || [ "$stalled" = 1 ]; then
  exit 1
fi
exit 0
