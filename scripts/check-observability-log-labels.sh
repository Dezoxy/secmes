#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/compose.prod.yaml"
ALLOY_CONFIG="$ROOT/infra/stack/observability/alloy/config.alloy"
DASHBOARD_DIR="$ROOT/infra/stack/observability/grafana/dashboards"
LOGS_DASHBOARD="$DASHBOARD_DIR/argus-logs.json"

fail() {
  echo "::error::$1" >&2
  exit 1
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    fail "Missing required observability guard input: $path"
  fi
}

require_file "$COMPOSE_FILE"
require_file "$ALLOY_CONFIG"
require_file "$LOGS_DASHBOARD"

compose_config="$(docker compose -f "$COMPOSE_FILE" config --format json)"

non_json_services="$(
  jq -r '
    .services
    | to_entries[]
    | select((.value.logging.driver // "") != "json-file")
    | .key
  ' <<<"$compose_config"
)"
unexpected_non_json_services="$(
  printf '%s\n' "$non_json_services" | grep -vx 'coturn' || true
)"
if [ -n "$unexpected_non_json_services" ]; then
  fail "Only coturn may opt out of centralized json-file logs. Unexpected non-json-file service(s): ${unexpected_non_json_services//$'\n'/, }"
fi

missing_log_labels="$(
  jq -r '
    .services
    | to_entries[]
    | select((.value.logging.driver // "") == "json-file")
    | select(((.value.logging.options.labels // "") | contains("com.docker.compose.service")) | not)
    | .key
  ' <<<"$compose_config"
)"
if [ -n "$missing_log_labels" ]; then
  fail "Every prod service must emit com.docker.compose.service into json-file log attrs. Missing: ${missing_log_labels//$'\n'/, }"
fi

grep -Eq 'service[[:space:]]*=[[:space:]]*"attrs\.\\"com\.docker\.compose\.service\\""' "$ALLOY_CONFIG" ||
  fail "Alloy must parse attrs.com.docker.compose.service from Docker json-file logs."
grep -Eq 'service[[:space:]]*=[[:space:]]*"service"' "$ALLOY_CONFIG" ||
  fail "Alloy must promote the parsed Compose service into the Loki service label."
grep -Eq 'service_name[[:space:]]*=[[:space:]]*"service"' "$ALLOY_CONFIG" ||
  fail "Alloy must keep service_name as a service-label alias for dashboard compatibility."
if grep -Eq 'docker\.sock|/var/run/docker\.sock' "$ALLOY_CONFIG"; then
  fail "Alloy log enrichment must not use the Docker socket."
fi

jq -e '
  .templating.list[]
  | select(.name == "service")
  | select(.query.label == "service" and .includeAll == true and .allValue == ".*")
' "$LOGS_DASHBOARD" >/dev/null ||
  fail "argus Logs dashboard must expose a service variable backed by the Loki service label."

jq -e '
  .templating.list[]
  | select(.name == "context")
  | select(.query.label == "context" and .includeAll == true and .allValue == ".*")
' "$LOGS_DASHBOARD" >/dev/null ||
  fail "argus Logs dashboard must expose a context variable backed by the Loki context label."

container_variables="$(
  jq -r '
    .templating.list[]?
    | select(.name == "container" or (.query.label? == "container"))
    | input_filename + ": variable " + (.name // "<unnamed>")
  ' "$DASHBOARD_DIR"/*.json
)"
if [ -n "$container_variables" ]; then
  fail "Grafana dashboards must not expose container IDs as the primary service filter: ${container_variables//$'\n'/; }"
fi

container_grouping="$(
  jq -r '
    .. | objects | .expr? // empty
    | select(test("by[[:space:]]*\\([^)]*container") or test("container[[:space:]]*=~[[:space:]]*\\\"\\\\$service\\\""))
    | input_filename + ": " + .
  ' "$DASHBOARD_DIR"/*.json
)"
if [ -n "$container_grouping" ]; then
  fail "Grafana dashboards must group/filter service views by service, not opaque container IDs: ${container_grouping//$'\n'/; }"
fi

jq -e '
  .. | objects | .expr? // empty
  | select(contains("{job=\"docker\"") and test("by[[:space:]]*\\([^)]*service"))
' "$LOGS_DASHBOARD" >/dev/null ||
  fail "argus Logs dashboard must contain at least one Loki panel grouped by service."

echo "observability log label guard OK"
