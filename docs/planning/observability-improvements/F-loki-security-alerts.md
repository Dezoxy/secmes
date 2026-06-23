# Idea F — Loki alerting rules for security events

**Effort:** S  **Impact:** Medium  **Status:** [x] Implemented

---

## Problem

The security dashboard (`argus-security.json`) shows breakglass events, WS auth failures, and rate-limit hits visually. However, nothing fires an alert when these spike. An attacker probing the API or a compromised account reusing credentials produces a detectable log pattern that should notify the operator immediately.

Loki has a built-in alerting ruler that sends alerts to the same Alertmanager instance that Prometheus uses — no new component needed.

---

## Changes required

### 1. New directory and rules file: `infra/stack/observability/loki/rules/argus-security.yml`

```yaml
groups:
  - name: security
    rules:
      # Any breakglass use is suspicious by design. More than 3 in one hour
      # means either legitimate emergency (operator should know) or a breach.
      - alert: BreakglassEventSpike
        expr: |
          count_over_time(
            {job="docker"} | json | context="BreakglassService" [1h]
          ) > 3
        labels: { severity: critical }
        annotations:
          summary: "More than 3 breakglass events in the last hour"
          description: "Check the security dashboard immediately. This may indicate emergency access abuse or a compromise."

      # Normal WS auth failures come from expired tokens (a few per 5 min is fine).
      # > 20 in 5 min suggests a credential-stuffing or token-replay attack.
      - alert: WSAuthFailureSpike
        expr: |
          count_over_time(
            {job="docker"} | json | msg="ws:auth_failed" [5m]
          ) > 20
        labels: { severity: warning }
        annotations:
          summary: "High WebSocket auth failure rate"

      # A spike in rate-limit hits suggests a client misbehaving or an attack.
      - alert: RateLimitHitSpike
        expr: |
          count_over_time(
            {job="docker"} | json | msg="ws:subscribe_rate_limited" [5m]
          ) > 50
        labels: { severity: warning }
        annotations:
          summary: "High WS subscribe rate-limit hit count"

      # Repeated session refresh failures can indicate token-replay or confused clients.
      - alert: SessionRefreshFailureSpike
        expr: |
          count_over_time(
            {job="docker", level="warn"} | json | context="SessionTokenController" [5m]
          ) > 30
        labels: { severity: warning }
        annotations:
          summary: "Repeated session refresh failures"
```

### 2. `infra/stack/observability/loki/loki-config.yml`

Enable the ruler component in the Loki monolith config:

```yaml
ruler:
  storage:
    type: local
    local:
      directory: /etc/loki/rules
  rule_path: /tmp/loki-ruler
  alertmanager_url: http://alertmanager:9093
  ring:
    kvstore:
      store: inmemory
  enable_api: true
  enable_alertmanager_v2: true
```

### 3. `compose.prod.yaml` — loki service

Mount the rules directory into the Loki container:

```yaml
loki:
  volumes:
    - ./infra/stack/observability/loki/loki-config.yml:/etc/loki/loki-config.yml:ro
    - ./infra/stack/observability/loki/rules:/etc/loki/rules:ro   # add this line
    - loki-data:/loki
```

Also add a `tmpfs` entry for the ruler's working directory (`/tmp/loki-ruler`) since the container runs with a read-only root fs.

---

## Notes

- The Loki ruler sends alerts to Alertmanager using the same protocol as Prometheus. Idea A (wiring the Alertmanager receiver) must be done first for these to actually notify anyone.
- The `{job="docker"}` selector matches the existing Alloy scrape config — the same label used in all dashboards.
- Thresholds (3 breakglass/hour, 20 WS failures/5min, etc.) are starting points. Tune them once real traffic baselines are established.
- These rules do NOT query message content, user IDs, or sensitive fields — only `context`, `msg`, and `level` labels, which carry only categorical metadata (invariant #2 safe).

---

## Verification

1. `docker compose exec loki wget -qO- http://localhost:3100/loki/api/v1/rules` — should return the loaded rules.
2. In Grafana → Alerting → Alert rules → filter by datasource "Loki" — the four security rules should appear.
3. Inject a test: generate > 20 fake `ws:auth_failed` log lines via the API test harness → `WSAuthFailureSpike` should appear as `Firing` in Alertmanager within 1 minute.
