#!/usr/bin/env bash
# argus — systemd failure notifier. Posts a minimal Sentry event to GlitchTip when a worker unit fails.
# Called by argus-notify-failure@<unit>.service via OnFailure=argus-notify-failure@%p.service.
# Argument: %i (the failing unit's name prefix, e.g. "argus-db-backup").
#
# Security model:
#   - Reads the Sentry DSN from $CREDENTIALS_DIRECTORY/sentry-dsn (systemd LoadCredential).
#   - DSN is a WRITE-ONLY ingest key — it cannot read events or access GlitchTip admin APIs.
#   - Event payload is metadata only: unit name, timestamp, level. Never plaintext content (invariant #2).
#   - Exits 0 in ALL cases: a failing notifier must never shadow the original failure in journalctl.
set -euo pipefail
# Global ERR trap: if any unguarded command exits non-zero, exit 0 rather than shadowing the original
# failure in the journal with a non-zero notifier exit. The explicit || guards on openssl/curl remain
# for clarity; this is the backstop for paths like the `tr` read (TOCTOU) and `date` inside log().
trap 'exit 0' ERR

UNIT="${1:?unit name (failing service prefix) required}"
DSN_FILE="${CREDENTIALS_DIRECTORY:-}/sentry-dsn"

# Validate unit name before interpolating into JSON. systemd.unit(5) restricts names to
# [a-zA-Z0-9._:@-], so this also rules out any character that could malform the JSON body.
[[ "$UNIT" =~ ^[a-zA-Z0-9._:@-]+$ ]] || { printf 'notify: invalid unit name "%s" — aborting\n' "$UNIT" >&2; exit 0; }

log() { printf '[%s] notify: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Graceful no-op when sentry_dsn is not yet provisioned (empty file seeded by argus-secrets.service).
# The operator arms it post-deploy: create a GlitchTip project → copy DSN → store as argus-sentry-dsn
# in Key Vault → redeploy (or systemctl restart argus-secrets && restart the api).
if [[ ! -s "$DSN_FILE" ]]; then
  log "sentry_dsn not provisioned — ${UNIT} failed (logged to journal only)"
  exit 0
fi

DSN="$(tr -d '[:space:]' < "$DSN_FILE")"

# Parse DSN: https://PUBLIC_KEY@HOST/PROJECT_ID
# The public key is a write-only ingest key (not admin credentials).
without_proto="${DSN#*//}"        # PUBLIC_KEY@HOST/PROJECT_ID
public_key="${without_proto%%@*}" # PUBLIC_KEY
remainder="${without_proto#*@}"   # HOST/PROJECT_ID
host="${remainder%%/*}"           # HOST
project_id="${remainder##*/}"     # PROJECT_ID

[[ -n "$public_key" && -n "$host" && -n "$project_id" ]] || {
  log "malformed sentry_dsn — ${UNIT} failed (logged to journal only)"
  exit 0
}

# 32-char hex event ID. openssl doesn't JIT (MemoryDenyWriteExecute-safe). Guard with || so a missing
# openssl binary doesn't abort via set -e before the always-exit-0 guarantee takes effect.
event_id="$(openssl rand -hex 16 2>/dev/null)" || { log "openssl unavailable — ${UNIT} failed (logged to journal only)"; exit 0; }
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# POST to the Sentry store endpoint. Intentionally NO --fail: a curl error or non-200 must not mask the
# original failure in journalctl — we log the outcome and always exit 0.
http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -H 'Content-Type: application/json' \
  -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=argus-notify/1, sentry_key=${public_key}" \
  -d "{\"event_id\":\"${event_id}\",\"timestamp\":\"${timestamp}\",\"platform\":\"other\",\"level\":\"fatal\",\"logger\":\"argus.system\",\"message\":\"systemd unit failed: ${UNIT}\",\"tags\":[{\"key\":\"unit\",\"value\":\"${UNIT}\"}]}" \
  "https://${host}/api/${project_id}/store/" 2>/dev/null || printf '000')"

if [[ "$http_code" == 200 ]]; then
  log "event delivered to GlitchTip (${host}): ${UNIT} failed"
else
  log "GlitchTip delivery failed (HTTP ${http_code}) — ${UNIT} failed (logged to journal only)"
fi

# Always exit 0 — the notifier must never shadow the real failure.
exit 0
