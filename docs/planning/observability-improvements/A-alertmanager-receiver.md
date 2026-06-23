# Idea A — Alertmanager receiver + infrastructure alerts

**Effort:** S  **Impact:** Critical  **Status:** [x] Implemented

---

## Problem

The Alertmanager receiver is `null`. Every alert — API down, high error rate, p95 spike — fires into a void and is only visible inside the Alertmanager UI. No one is notified.

Additionally, there are no alerts for Redis or Postgres being unavailable, meaning the database and cache can silently die without triggering anything.

---

## Changes required

### 1. `infra/stack/observability/alertmanager/alertmanager.yml`

Replace the `null` receiver with a webhook receiver that reads the URL from a mounted secret:

```yaml
receivers:
  - name: 'webhook'
    webhook_configs:
      - url_file: /run/secrets/alertmanager_webhook_url
        send_resolved: true

route:
  receiver: 'webhook'
  # ... rest of existing route config
```

A Slack incoming webhook URL is the simplest option. PagerDuty, OpsGenie, or any webhook works.

### 2. `compose.prod.yaml`

Add `alertmanager_webhook_url` to the secrets block and mount it into the alertmanager service:

```yaml
alertmanager:
  secrets:
    - alertmanager_webhook_url

secrets:
  alertmanager_webhook_url:
    file: /run/secrets/alertmanager_webhook_url  # or external: true for Key Vault delivery
```

### 3. `infra/stack/observability/prometheus/rules/argus-api.yml`

Add these missing infrastructure alerts:

```yaml
- alert: RedisDown
  expr: up{job="redis"} == 0
  for: 2m
  labels: { severity: critical }
  annotations:
    summary: "Redis is unreachable"

- alert: PostgresDown
  expr: up{job="postgres"} == 0
  for: 2m
  labels: { severity: critical }
  annotations:
    summary: "Postgres is unreachable"

- alert: HighRedisMemoryUsage
  expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "Redis memory above 85%"

- alert: HighPostgresConnections
  expr: >
    pg_stat_activity_count{datname="argus"}
    / pg_settings_max_connections > 0.8
  for: 5m
  labels: { severity: warning }
  annotations:
    summary: "Postgres connection pool above 80%"

- alert: LokiIngestionSilent
  expr: rate(loki_distributor_lines_received_total[5m]) == 0
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: "Loki is not receiving any log lines — pipeline may be broken"
```

---

## Arming step (post-deploy, not in code)

1. Create an incoming webhook in Slack (or equivalent).
2. Store the URL as the `alertmanager_webhook_url` secret in Azure Key Vault.
3. The deploy script delivers it to `/run/secrets/alertmanager_webhook_url` on the VM.
4. Send `SIGHUP` to Alertmanager to hot-reload: `docker compose kill -s HUP alertmanager`.

---

## Verification

1. `docker compose exec alertmanager wget -qO- http://localhost:9093/api/v2/receivers` — should show the webhook receiver.
2. In the Alertmanager UI (grafana.4rgus.com/-/alertmanager), trigger a test alert using the "Test" button.
3. Confirm a notification appears in the webhook target (Slack, etc.).
4. Stop Redis temporarily: `docker compose stop redis` — `RedisDown` should fire within 2 minutes and notify.
