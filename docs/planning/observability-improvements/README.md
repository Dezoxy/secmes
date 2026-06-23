# Observability Improvements — Roadmap

Next steps after PR #325 (structured logs + distributed tracing + infra metrics + 5 dashboards).

Check the box when an idea is fully implemented and merged.

---

## Status

| # | Idea | Effort | Impact | Status |
|---|------|--------|--------|--------|
| A | [Alertmanager receiver + infra alerts](./A-alertmanager-receiver.md) | S | Critical | [x] |
| B | [Exemplars — click metric spike → open trace](./B-exemplars.md) | S | High | [x] |
| C | [Business/domain metrics](./C-business-metrics.md) | M | High | [x] |
| D | [Continuous profiling — Grafana Pyroscope](./D-pyroscope-profiling.md) | M | Medium | [ ] |
| E | [SLO dashboard + multi-burn-rate alerts](./E-slo-dashboard.md) | M | Medium | [ ] |
| F | [Loki alerting rules for security events](./F-loki-security-alerts.md) | S | Medium | [x] |
| G | [GlitchTip arming runbook + deployment annotations](./G-glitchtip-annotations.md) | S | Low-Med | [ ] |

---

## Current stack state (as of PR #325)

| Area | Working | Gap |
|------|---------|-----|
| Logs | Pino JSON → Loki, log↔trace links | Loki alerting rules, cardinality visibility |
| Traces | OTel → Tempo, trace→log links, URL-redacted | Domain context in spans, exemplar link back to metrics |
| Metrics | HTTP latency/rate, process stats, Postgres, Redis | Business metrics, real WS gauge, SLO math |
| Alerting | Rules: API down, 5xx rate, p95 latency | Redis/Postgres down, log-pattern alerts |
| Alertmanager | Config in place | **Receiver is `null` — alerts fire nowhere** |
| Error tracking | GlitchTip deployed, scrubbing in place | DSN not provisioned → total no-op |
| Profiling | — | Not added (Pyroscope) |

## Recommended implementation order

1. **A** first — alerts are completely silent today; fixes the most critical gap
2. **B** second — one-file change that closes the metrics→trace navigation gap
3. **C** third — replaces the fragile Loki-approximation WS panel; enables real auth rate metrics
4. **F** fourth — small change; adds breakglass/auth-failure spike detection
5. **D** fifth — adds the profiling pillar (new compose service + npm package)
6. **E** sixth — useful once stable baselines exist
7. **G** last — polish; activate on first production deploy
