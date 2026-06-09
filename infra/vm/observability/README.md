# Observability stack (roadmap #47, Slice B)

Prometheus + Grafana + Alertmanager for the argus VM. **Built as code; gated, not armed** (like the rest of
the deploy track). Threat model: [`docs/threat-models/observability.md`](../../../docs/threat-models/observability.md).

```
api:9090 /metrics (content-blind, internal)  ──scrape──▶ prometheus ──▶ alertmanager (alerts)
                                                              │
                                                              ▼
                                                   grafana  ──Caddy──▶ grafana.4rgus.com (Cloudflare Access)
```

## What's here

| Path | Role |
|------|------|
| `prometheus/prometheus.yml` | scrape config (scrapes `api:9090` + self), alerting → `alertmanager:9093` |
| `prometheus/rules/argus-api.yml` | alert rules + the API **SLOs** (availability, 5xx < 1%/5%, p95 < 1s) |
| `alertmanager/alertmanager.yml` | routing + a **null receiver** (wire a real webhook/email at arming, secret from Key Vault) |
| `grafana/provisioning/datasources/` | the Prometheus datasource (read-only) |
| `grafana/provisioning/dashboards/` | the file-based dashboard provider |
| `grafana/dashboards/argus-api-overview.json` | starter dashboard (request rate, 5xx ratio, latency p50/95/99, process) |

## Security model (see the threat model)

- **`/metrics` is content-blind** — counts/latencies/process stats with `{method, route-template, status}`
  labels only; never content, keys, tokens, PII, ids, or query strings.
- **Internal-only** — Prometheus + Alertmanager have **no published ports** and aren't routed by Caddy. Only
  **Grafana** has ingress, behind **Cloudflare Access** + its own login.
- **Secrets via Key Vault** — Grafana's admin password is delivered as a credential file
  (`GF_SECURITY_ADMIN_PASSWORD__FILE`); no secret values live in this tree.

## Validate locally

```bash
docker run --rm --entrypoint promtool -v "$PWD/infra/vm/observability/prometheus:/etc/prometheus:ro" \
  prom/prometheus:v2.55.1 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint amtool -v "$PWD/infra/vm/observability/alertmanager:/etc/alertmanager:ro" \
  prom/alertmanager:v0.28.1 check-config /etc/alertmanager/alertmanager.yml
```

`deploy.sh` stages this tree into `/opt/argus/infra/vm/observability` (the compose services bind-mount it
read-only). Pin/refresh the image tags (Dependabot-tracked) before arming.
