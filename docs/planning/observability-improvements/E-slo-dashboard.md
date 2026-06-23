# Idea E — SLO dashboard + multi-burn-rate alerts

**Effort:** M  **Impact:** Medium  **Status:** [ ] Not implemented

---

## Problem

Current threshold alerts miss two important failure patterns:
- **Brief spikes:** A 30-second outage won't trigger a "5xx > 5% for 10m" alert.
- **Slow burns:** A sustained 2% error rate over hours drains the error budget silently.

SLO-based multi-burn-rate alerting (from the Google SRE workbook) catches both patterns without excessive false positives.

---

## SLO definitions

| SLO | Target | Window |
|-----|--------|--------|
| Availability | 99.5% of requests return non-5xx | 30-day rolling |
| Latency | 95% of requests complete in < 500ms | 30-day rolling |

These map to a **0.5% error budget** per month for availability (~3.6 hours of allowed downtime).

---

## Changes required

### 1. New file: `infra/stack/observability/prometheus/rules/argus-slo.yml`

```yaml
groups:
  - name: argus-slo-recording
    interval: 30s
    rules:
      # ── Availability SLO ────────────────────────────────────────────────────
      - record: argus:http_error_ratio:rate5m
        expr: |
          sum(rate(argus_api_http_requests_total{status=~"5.."}[5m]))
          / sum(rate(argus_api_http_requests_total[5m]))

      - record: argus:http_error_ratio:rate1h
        expr: |
          sum(rate(argus_api_http_requests_total{status=~"5.."}[1h]))
          / sum(rate(argus_api_http_requests_total[1h]))

      - record: argus:http_error_ratio:rate6h
        expr: |
          sum(rate(argus_api_http_requests_total{status=~"5.."}[6h]))
          / sum(rate(argus_api_http_requests_total[6h]))

      # ── Latency SLO ─────────────────────────────────────────────────────────
      - record: argus:http_latency_compliance:rate5m
        expr: |
          sum(rate(argus_api_http_request_duration_seconds_bucket{le="0.5"}[5m]))
          / sum(rate(argus_api_http_request_duration_seconds_count[5m]))

      - record: argus:http_latency_compliance:rate1h
        expr: |
          sum(rate(argus_api_http_request_duration_seconds_bucket{le="0.5"}[1h]))
          / sum(rate(argus_api_http_request_duration_seconds_count[1h]))

  - name: argus-slo-alerts
    rules:
      # Fast-burn page: consumes 2% of monthly budget in 1 hour
      - alert: AvailabilitySLOFastBurn
        expr: |
          argus:http_error_ratio:rate1h > (14 * 0.005)
          and argus:http_error_ratio:rate5m > (14 * 0.005)
        labels: { severity: critical, slo: availability }
        annotations:
          summary: "Fast error-budget burn — availability SLO at risk"

      # Slow-burn warn: consuming budget at 6× rate over 6h
      - alert: AvailabilitySLOSlowBurn
        expr: |
          argus:http_error_ratio:rate6h > (6 * 0.005)
          and argus:http_error_ratio:rate1h > (6 * 0.005)
        labels: { severity: warning, slo: availability }
        annotations:
          summary: "Slow error-budget burn — review error rate trend"

      # Latency SLO breach
      - alert: LatencySLOBreach
        expr: argus:http_latency_compliance:rate1h < 0.95
        for: 10m
        labels: { severity: warning, slo: latency }
        annotations:
          summary: "Less than 95% of requests completing under 500ms"
```

### 2. `infra/stack/observability/prometheus/prometheus.yml`

Add the new rules file to the `rule_files` block:

```yaml
rule_files:
  - /etc/prometheus/rules/argus-api.yml
  - /etc/prometheus/rules/argus-slo.yml   # add this line
```

### 3. New file: `infra/stack/observability/grafana/dashboards/argus-slo.json`

Dashboard with three rows:

**Row 1 — Budget status:**
- Error budget remaining (stat, %) — `1 - (sum(increase(argus_api_http_requests_total{status=~"5.."}[30d])) / sum(increase(argus_api_http_requests_total[30d]))) / 0.005`
- Latency SLO compliance (stat, %) — `argus:http_latency_compliance:rate1h`
- Time to budget exhaustion at current burn rate (stat)

**Row 2 — Burn rate trends:**
- Availability burn rate over time (timeseries, multiple windows: 5m / 1h / 6h)
- Latency compliance over time (timeseries)

**Row 3 — Route-level breakdown:**
- 5xx ratio by route (table, sorted desc) — identifies which routes are burning the budget
- p95 latency by route (table) — identifies which routes violate the latency SLO

---

## Notes

- The multi-burn-rate alert avoids the false-positive problem of raw thresholds: it only pages if the burn rate is elevated across *two* time windows simultaneously.
- These recording rules add minimal Prometheus load — they pre-compute ratios that the dashboard would otherwise compute on every panel refresh.
- Implement this after stable traffic baselines exist (Idea B and C first helps establish them).

---

## Verification

1. `docker compose exec prometheus promtool check rules /etc/prometheus/rules/argus-slo.yml` — should pass with no errors.
2. In Grafana → Alerting → Alert rules — both SLO alerts should appear.
3. Open `argus-slo.json` — all panels should populate with data from the last hour.
4. Temporarily inject errors (e.g., stop Postgres briefly) and verify the fast-burn alert fires.
