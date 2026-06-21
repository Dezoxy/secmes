#!/usr/bin/env bash
# argus — message-retention TTL prune worker (Track 4 slice 4 — the v1 deletion). Standalone; runs on the VM
# via a systemd timer (see argus-message-retention.{service,timer}). Enforces the hard retention CEILING the
# server promises as a transient relay:
#   • messages — delete rows older than 90 days (the ceiling reviewed in docs/threat-models/message-retention.md
#     and DB-enforced by migration 0044's argus_msg_prune RLS policies). This is the ONLY deletion this track
#     ships in v1: a flat TTL, no per-device delivery gate (Codex P1 — deferred behind a per-device-tracking
#     prerequisite). A device returning within 90 days catches up via the slice-1 prune-safe backfill cursor.
#
# Security model (identical to infra/audit-prune/prune-audit.sh — the proven pattern this clones):
#   - Connects to Postgres as the least-privilege `argus_msg_prune` role, whose RLS policies (migration 0044)
#     expose + allow DELETE on ONLY messages past the 90-day ceiling — across tenants, but never an in-window
#     (live) row, and via a column-scoped grant that excludes `ciphertext` entirely. The time window is
#     DATABASE-enforced, so even a buggy predicate or a leaked credential cannot touch an in-window row, and
#     the crypto-blind boundary holds even with a leaked credential (invariant #1). #262 OR-combine bypass is
#     closed by 0044 (the messages_tenant_isolation re-scope TO argus_app).
#   - The DB is reached IN-CONTAINER via `docker compose exec -T postgres psql …` over the container's local
#     socket (PG has NO published host port — invariant #3). The official image trusts local connections, so
#     `argus_msg_prune` connects with NO password — there is NO DB secret on the host at all (and no egress).
#   - Logs COUNTS ONLY — never row ids (invariant #2, threat-model §7 cond 5). `messages` rows are
#     ciphertext-bearing; emitting a pruned id would leak conversation/tenant metadata about the very content
#     this prune exists to discard.
#   - On a DB-unreachable / query error the worker exits non-zero so OnFailure= alerts — a prune that cannot
#     reach the DB must not report success (the BKP-1 lesson). The timer retries next run.
#
# Requires: docker compose (reaches the postgres container; `argus` is in the docker group). psql runs INSIDE
# the postgres container. No AWS CLI, no credential file, no network egress — strictly less than the
# attachment-cleanup worker. Same shape as infra/audit-prune/prune-audit.sh.
set -euo pipefail

BATCH="${PRUNE_BATCH:-5000}"
MAX_ROUNDS="${PRUNE_MAX_ROUNDS:-200}"

# --- Non-secret config, provided by the systemd unit's Environment=. No PGHOST/PGPORT/PGPASSFILE: the DB is
#     reached in-container via `docker compose exec` (below), not over a host TCP port (invariant #3). ---
: "${PGUSER:?PGUSER required (argus_msg_prune)}"
: "${PGDATABASE:?PGDATABASE required}"

# Run psql INSIDE the running postgres container — PG has no published port (invariant #3), and the official
# image trusts local-socket connections, so `-U "$PGUSER"` (argus_msg_prune) assumes the least-privilege role
# with NO password. Its RLS policies still expose only past-window rows. COMPOSE_FILE + COMPOSE_PROJECT_NAME
# (set by the unit) attach to the deployed stack; `-T` runs without a TTY.
pgx() { docker compose exec -T postgres "$@"; }

log() { printf '[%s] message-retention: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Prune one table in bounded batches. $1 = table, $2 = age column, $3 = retention interval (SQL).
# Each batch deletes via `delete … where id in (select id … where <age> < now()-interval order by <age>
# limit N)` and reports the count via a CTE `count(*)` — so NO row id is ever emitted, and only id/<age> (the
# column-scoped grant) are read, never ciphertext. The argus_msg_prune RLS policy independently restricts
# visibility/DELETE to past-window rows, so the predicate here is belt-and-suspenders (and keeps the batch
# deterministic). The retention interval ('90 days') MUST match the 0044 RLS policy literal — the single
# reviewed constant; the RLS DELETE policy is the DB-enforced hard floor even if this drifts. Prints the total
# pruned to stdout; returns non-zero (without printing a total) if the DB is unreachable or returns a
# non-numeric count.
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

if ! pruned_messages="$(prune_table messages created_at '90 days')"; then
  log "messages prune failed (DB unreachable?) — failing the unit so OnFailure alerts"
  exit 1
fi

log "done pruned_messages=${pruned_messages}"
exit 0
