# Idea B — Exemplars: click a metric spike → open the trace

**Effort:** S  **Impact:** High  **Status:** [x] Implemented

---

## Problem

The p95 latency dashboard shows a spike, but you cannot navigate from that spike to the actual request that caused it. Exemplars are the Prometheus-native bridge: each histogram observation can carry a `traceId` label, which Grafana renders as a clickable dot that opens Tempo.

---

## How it works

1. A slow request finishes → the HTTP middleware calls `histogram.observe({ value: durationSecs, exemplarLabels: { traceId } })` where `traceId` comes from the active OTel span context.
2. Prometheus stores the exemplar alongside the bucket sample.
3. In Grafana, the latency panel renders a dot on the histogram for that sample.
4. Clicking the dot opens the Tempo trace for that exact request.

---

## Changes required

### 1. `apps/api/src/observability/metrics.ts`

Import the OTel trace API to read the active span context, then pass exemplar labels when recording duration:

```ts
import { trace } from '@opentelemetry/api';

// Inside the request duration recording:
const activeSpan = trace.getActiveSpan();
const spanContext = activeSpan?.spanContext();

httpRequestDuration.observe(
  { method, route, status },
  durationSeconds,
  // Exemplar — attached only when a trace is active (10% sampling rate)
  spanContext?.traceId ? { traceId: spanContext.traceId } : undefined,
);
```

prom-client's `Histogram.observe()` accepts an optional third argument for exemplar labels as of v14+.

### 2. `infra/stack/observability/prometheus/prometheus.yml`

Enable exemplar storage in the global block:

```yaml
global:
  scrape_interval: 15s
  exemplar_storage:
    enable_exemplars: true
```

### 3. `infra/stack/observability/grafana/dashboards/argus-traces.json` and `argus-api-overview.json`

For the p95 latency panels, set `"exemplar": true` on the Prometheus target inside the panel JSON. Grafana then renders exemplar dots automatically when the datasource returns them.

```json
"targets": [
  {
    "datasource": { "uid": "argus-prometheus" },
    "expr": "histogram_quantile(0.95, ...)",
    "exemplar": true
  }
]
```

---

## Notes

- Exemplars are only recorded when a trace is active (i.e., within the 10% sampling window). At lower traffic this means dots are sparse — that is expected and correct.
- The `traceId` label is a 32-char hex string; Grafana knows to look it up in the Tempo datasource because of the `tracesToMetrics` link already configured in `tempo.yml`.
- No security concern: `traceId` is an opaque random identifier with no user or content information.

---

## Verification

1. Send several requests to a slow endpoint (or temporarily lower the sampling rate to 100% via `OTEL_TRACES_SAMPLER_ARG=1.0`).
2. Open the "p95 latency by route" panel in `argus-traces.json`.
3. Small circles should appear on the histogram line.
4. Click one → Tempo should open showing the full trace for that request.
