# Observability stack (roadmap #47, Slice B + #47b logs)

Prometheus + Grafana + Alertmanager (metrics, #47) and **Loki + Alloy** (centralized logs, #47b) for the argus
VM. **Built as code; gated, not armed** (like the rest of the deploy track). Threat models:
[`observability.md`](../../../docs/threat-models/observability.md) (metrics) +
[`centralized-logs.md`](../../../docs/threat-models/centralized-logs.md) (logs).

```
api:9090 /metrics (content-blind, internal)  ──scrape──▶ prometheus ──▶ alertmanager (alerts)
container stdout (json logs) ──Alloy (ro tail, no socket, scrub)──▶ loki      │
                                                              │               │
                                                              ▼               ▼
                                                   grafana  ──Caddy──▶ grafana.4rgus.com (Cloudflare Access)
```

## What's here

| Path | Role |
|------|------|
| `prometheus/prometheus.yml` | scrape config (scrapes `api:9090` + self), alerting → `alertmanager:9093` |
| `prometheus/rules/argus-api.yml` | alert rules + the API **SLOs** (availability, 5xx < 1%/5%, p95 < 1s) |
| `alertmanager/alertmanager.yml` | routing + a **null receiver** (wire a real webhook/email at arming, secret from Key Vault) |
| `grafana/provisioning/datasources/` | the Prometheus **and Loki** datasources (read-only) |
| `grafana/provisioning/dashboards/` | the file-based dashboard provider |
| `grafana/dashboards/argus-api-overview.json` | starter dashboard (request rate, 5xx ratio, latency p50/95/99, process) |
| `loki/loki-config.yml` | Loki store (#47b) — filesystem, 7-day retention, no auth (internal) |
| `alloy/config.alloy` | Alloy collector (#47b) — tails container json-logs (read-only, **no socket**), scrubs secret shapes, pushes to Loki |

## Security model (see the threat model)

- **`/metrics` is content-blind** — counts/latencies/process stats with `{method, route-template, status}`
  labels only; never content, keys, tokens, PII, ids, or query strings.
- **Internal-only** — Prometheus + Alertmanager **and Loki + Alloy** have **no published ports** and aren't
  routed by Caddy. Only **Grafana** has ingress, behind **Cloudflare Access** + its own login.
- **Secrets via Key Vault** — Grafana's admin password is delivered as a credential file
  (`GF_SECURITY_ADMIN_PASSWORD__FILE`); no secret values live in this tree.
- **Logs are IDs/metadata only** — Alloy tails container logs from a **read-only** `/var/lib/docker/containers`
  mount with **NO Docker socket** (a socket is daemon-root-equivalent); it runs uid 0 only to read the
  root-owned logs, bounded by `cap_drop:[ALL]` + read-only rootfs. A scrub stage masks any
  bearer/JWT/presigned-URL value as defense-in-depth on top of the app's IDs-only logging discipline.

## Validate locally

```bash
docker run --rm --entrypoint promtool -v "$PWD/infra/stack/observability/prometheus:/etc/prometheus:ro" \
  prom/prometheus:v2.55.1 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint amtool -v "$PWD/infra/stack/observability/alertmanager:/etc/alertmanager:ro" \
  prom/alertmanager:v0.28.1 check-config /etc/alertmanager/alertmanager.yml
# logs (#47b)
docker run --rm -v "$PWD/infra/stack/observability/loki:/etc/loki:ro" \
  grafana/loki:3.5.0 -config.file=/etc/loki/loki-config.yml -verify-config
docker run --rm -v "$PWD/infra/stack/observability/alloy:/etc/alloy:ro" \
  grafana/alloy:v1.16.3 validate /etc/alloy/config.alloy
```

`deploy.sh` stages this tree into `/opt/argus/infra/stack/observability` (the compose services bind-mount it
read-only). Pin/refresh the image tags (Dependabot-tracked) before arming.
