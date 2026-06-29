#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/compose.prod.yaml"
ALLOY_CONFIG="$ROOT/infra/stack/observability/alloy/config.alloy"
DASHBOARD_DIR="$ROOT/infra/stack/observability/grafana/dashboards"
LOGS_DASHBOARD="$DASHBOARD_DIR/argus-logs.json"
LOKI_CONFIG="$ROOT/infra/stack/observability/loki/loki-config.yml"
LOKI_RULES_DIR="$ROOT/infra/stack/observability/loki/rules"
DEPLOY_SH="$ROOT/infra/stack/deploy/deploy.sh"

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

require_dir() {
  local path="$1"
  if [ ! -d "$path" ]; then
    fail "Missing required observability guard input directory: $path"
  fi
}

require_file "$COMPOSE_FILE"
require_file "$ALLOY_CONFIG"
require_file "$LOGS_DASHBOARD"
require_file "$LOKI_CONFIG"
require_dir "$LOKI_RULES_DIR"
require_file "$DEPLOY_SH"

compose_config="$(docker compose -f "$COMPOSE_FILE" config --format json)"

coturn_log_driver="$(jq -r '.services.coturn.logging.driver // ""' <<<"$compose_config")"
if [ "$coturn_log_driver" != "local" ]; then
  fail "coturn must stay on Docker's local logging driver so TURN relay metadata is not centralized in Loki."
fi
coturn_max_size="$(jq -r '.services.coturn.logging.options["max-size"] // ""' <<<"$compose_config")"
coturn_max_file="$(jq -r '.services.coturn.logging.options["max-file"] // ""' <<<"$compose_config")"
if [ "$coturn_max_size" != "10m" ] || [ "$coturn_max_file" != "3" ]; then
  fail "coturn local logs must keep short retention: expected max-size=10m and max-file=3."
fi

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
    | select((((.value.logging.options.labels // "") | split(",") | map(gsub("^[[:space:]]+|[[:space:]]+$"; "")) | index("com.docker.compose.service")) == null))
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
loki_image="$(jq -r '.services.loki.image // ""' <<<"$compose_config")"
if [[ "$loki_image" =~ (^|/)grafana/loki:3\.5\.0(@sha256:[[:alnum:]]+)?$ ]]; then
  fail "Loki 3.5.0 has a known structured-metadata accounting bug that spams negative structured metadata errors; use 3.5.1 or newer."
fi
grep -Eq 'directory:[[:space:]]*/etc/loki/rules' "$LOKI_CONFIG" ||
  fail "Loki ruler must read checked-in rule files from /etc/loki/rules."
if ! find "$LOKI_RULES_DIR" -mindepth 2 -maxdepth 2 -type f -name '*.yml' -print -quit | grep -q .; then
  fail "Loki ruler must have at least one checked-in rules/*/*.yml file."
fi
if grep -Eq 'docker\.sock|/var/run/docker\.sock' "$ALLOY_CONFIG"; then
  fail "Alloy log enrichment must not use the Docker socket."
fi
docker_socket_volumes="$(
  jq -r '
    .services
    | to_entries[]
    | .key as $service
    | (.value.volumes // [])[]
    | select(((.source // "") | test("docker\\.sock")) or ((.target // "") | test("docker\\.sock")))
    | $service + ": " + (.source // "") + " -> " + (.target // "")
  ' <<<"$compose_config"
)"
if [ -n "$docker_socket_volumes" ]; then
  fail "Compose services must not mount the daemon-root-equivalent Docker socket: ${docker_socket_volumes//$'\n'/; }"
fi
docker_socket_named_volumes="$(
  jq -r '
    (.volumes // {})
    | to_entries[]
    | .key as $volume
    | .value as $config
    | [
        ($config.driver // ""),
        ($config.driver_opts.device // ""),
        ($config.driver_opts.o // ""),
        ($config.driver_opts.type // "")
      ]
    | map(tostring)
    | join(" ")
    | select(test("docker\\.sock"))
    | $volume + ": " + .
  ' <<<"$compose_config"
)"
if [ -n "$docker_socket_named_volumes" ]; then
  fail "Compose named volumes must not bind the daemon-root-equivalent Docker socket: ${docker_socket_named_volumes//$'\n'/; }"
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

grep -Fq 'ensure_grafana_dashboards_visible' "$DEPLOY_SH" ||
  fail "deploy.sh must verify Grafana dashboard visibility inside the container after rollout."
grep -Fq "docker exec \"\$cid\" sh -c" "$DEPLOY_SH" ||
  fail "deploy.sh must inspect Grafana's container-side dashboard mount, not only host-side files."
grep -Fq 'find /etc/grafana/dashboards -type f -name "*.json"' "$DEPLOY_SH" ||
  fail "deploy.sh must require Grafana to see at least one dashboard JSON file."
grep -Fq '/etc/grafana/provisioning/dashboards/provider.yml' "$DEPLOY_SH" ||
  fail "deploy.sh must require Grafana to see its dashboard provider file."
grep -Fq -- '--force-recreate --no-deps grafana' "$DEPLOY_SH" ||
  fail "deploy.sh must force-recreate Grafana when refreshed bind mounts are not visible."
grep -Fq 'ensure_loki_rules_visible' "$DEPLOY_SH" ||
  fail "deploy.sh must verify Loki rule visibility inside the container after rollout."
grep -Fq "docker cp \"\$cid:/etc/loki/rules/.\"" "$DEPLOY_SH" ||
  fail "deploy.sh must inspect Loki's container-side rules mount without requiring a shell in the Loki image."
grep -Fq "find \"\$tmp\" -mindepth 2 -maxdepth 2 -type f -name \"*.yml\"" "$DEPLOY_SH" ||
  fail "deploy.sh must require Loki to see at least one tenant-scoped rule YAML file."
grep -Fq -- '--force-recreate --no-deps loki' "$DEPLOY_SH" ||
  fail "deploy.sh must force-recreate Loki when refreshed rule mounts are not visible."

echo "observability log label guard OK"
