#!/usr/bin/env bash
# argus — audit/session retention prune worker (review finding F1/AR-1). Standalone; runs on the VM via a
# systemd timer (see argus-audit-prune.{service,timer}). Enforces the retention windows the schema has only
# ever promised in prose:
#   • audit_events  — delete rows older than 90 days (the 0002 comment; attested in article-30-records.md).
#   • auth_sessions — delete rows expired more than 30 days ago (window from the 0032 comment; the prune
#     role + grant are in migration 0043).
#
# Security model:
#   - Connects to Postgres as the least-privilege `argus_prune` role, whose RLS policies (migration 0043)
#     expose + allow DELETE on ONLY rows past their retention window — never a live/in-window row, never any
#     tenant's content. The time window is DATABASE-enforced, so even a buggy predicate or a leaked credential
#     cannot touch an in-window row.
#   - The DB is reached IN-CONTAINER via `docker compose exec -T postgres psql …` over the container's local
#     socket (PG has NO published host port — invariant #3). The official image trusts local connections, so
#     `argus_prune` connects with NO password — there is NO DB secret on the host at all (and no B2/egress).
#   - Logs COUNTS ONLY — never row ids, never metadata/actor_sub/ip (invariant #2). audit_events holds
#     pseudonymous lookup metadata; emitting a pruned row id would leak the very thing we are bounding.
#   - On a DB-unreachable / query error the worker exits non-zero so OnFailure= alerts — a prune that cannot
#     reach the DB must not report success (the BKP-1 lesson). The timer retries next run.
#
# Requires: docker compose (reaches the postgres container; `argus` is in the docker group). psql runs INSIDE
# the postgres container. No AWS CLI, no credential file, no network egress — strictly less than the
# attachment-cleanup worker.
set -euo pipefail

BATCH="${PRUNE_BATCH:-5000}"
MAX_ROUNDS="${PRUNE_MAX_ROUNDS:-200}"

# --- Non-secret config, provided by the systemd unit's Environment=. No PGHOST/PGPORT/PGPASSFILE: the DB is
#     reached in-container via `docker compose exec` (below), not over a host TCP port (invariant #3). ---
: "${PGUSER:?PGUSER required (argus_prune)}"
: "${PGDATABASE:?PGDATABASE required}"

# Run psql INSIDE the running postgres container — PG has no published port (invariant #3), and the official
# image trusts local-socket connections, so `-U "$PGUSER"` (argus_prune) assumes the least-privilege role with
# NO password. Its RLS policies still expose only past-window rows. COMPOSE_FILE + COMPOSE_PROJECT_NAME (set by
# the unit) attach to the deployed stack; `-T` runs without a TTY.
pgx() { docker compose exec -T postgres "$@"; }

log() { printf '[%s] audit-prune: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Prune one table in bounded batches. $1 = table, $2 = age column, $3 = retention interval (SQL).
# Each batch deletes via `delete … where id in (select id … where <age> < now()-interval order by <age>
# limit N)` and reports the count via a CTE `count(*)` — so NO row id is ever emitted. The argus_prune RLS
# policy independently restricts visibility/DELETE to past-window rows, so the predicate here is
# belt-and-suspenders (and keeps the batch deterministic). Prints the total pruned to stdout; returns
# non-zero (without printing a total) if the DB is unreachable or returns a non-numeric count.
prune_table() {
  local table="$1" agecol="$2" age="$3" rounds=0 total=0 n
  while :; do
    rounds=$((rounds + 1))
    if ! n="$(pgx psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -At -c \
      "with del as (
         delete from ${table}
          where id in (
            select id from ${table}
             where ${agecol} < now() - interval '${age}'
             order by ${agecol}
             limit ${BATCH})
         returning 1)
       select count(*) from del")"; then
      return 1
    fi
    n="${n//$'\r'/}"
    n="${n//$'\n'/}" # strip only CR/LF — NOT spaces, so a malformed multi-field result fails the test below
    [[ "$n" =~ ^[0-9]+$ ]] || return 1
    total=$((total + n))
    [[ "$n" -eq 0 ]] && break
    if [[ "$rounds" -ge "$MAX_ROUNDS" ]]; then
      log "${table}: hit max rounds cap (${MAX_ROUNDS}) — stopping; remainder reaped next run"
      break
    fi
  done
  printf '%s' "$total"
}

if ! pruned_audit="$(prune_table audit_events created_at '90 days')"; then
  log "audit_events prune failed (DB unreachable?) — failing the unit so OnFailure alerts"
  exit 1
fi
if ! pruned_sessions="$(prune_table auth_sessions expires_at '30 days')"; then
  log "auth_sessions prune failed (DB unreachable?) — failing the unit so OnFailure alerts"
  exit 1
fi

log "done pruned_audit=${pruned_audit} pruned_sessions=${pruned_sessions}"
exit 0
