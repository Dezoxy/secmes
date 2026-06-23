# Idea C — Business/domain metrics

**Effort:** M  **Impact:** High  **Status:** [ ] Not implemented

---

## Problem

The current metrics only describe the HTTP transport layer. There is no answer to:
- "How many WebSocket connections are active right now?"
- "What is the real-time auth failure rate?"
- "How many MLS key operations is the crypto layer doing per second?"

The overview dashboard approximates active WebSocket connections from Loki log counts — this is fragile (depends on the log pipeline being healthy) and has a multi-minute lag.

---

## Metrics to add

All metrics must use only categorical labels. No user IDs, no tenant IDs, no email addresses as label values — only bounded enum-like values. This keeps cardinality low and avoids PII in the metrics store.

### `argus_ws_connections_active` (Gauge)

Tracks the real-time count of authenticated WebSocket connections.

- **Location:** `apps/api/src/realtime/realtime.gateway.ts`
- **Increment:** on successful `ws:auth` (after token validation passes)
- **Decrement:** on `handleDisconnect`
- **Labels:** none (global gauge; per-tenant breakdown would require tenant ID labels → PII risk)

Replaces the fragile Loki-approximation panel in `argus-api-overview.json`.

### `argus_auth_attempts_total` (Counter)

Tracks authentication attempts by outcome and method.

- **Location:** `apps/api/src/auth/webauthn.service.ts`, `session-token.service.ts`, `breakglass.service.ts`
- **Labels:**
  - `result`: `success` | `failure`
  - `method`: `webauthn` | `session` | `breakglass`
- **Use:** Powers a real auth-failure-rate alert (e.g., > 10 failures/min across all methods).

### `argus_messages_sent_total` (Counter)

Tracks message throughput.

- **Location:** `apps/api/src/messaging/messaging.service.ts` — increment after a message is persisted.
- **Labels:** none (global throughput; per-conversation or per-tenant breakdown requires IDs → PII)
- **Use:** Baseline for capacity planning; anomaly detection (a sudden 10× spike warrants investigation).

### `argus_mls_operations_total` (Counter)

Tracks cryptographic MLS operations.

- **Location:** `packages/crypto/src/` — wherever `key_package`, `commit`, and `welcome` operations are performed.
- **Labels:**
  - `op`: `key_package` | `commit` | `welcome` | `decrypt` | `encrypt`
- **Use:** Signals MLS negotiation load; useful for sizing crypto worker threads and diagnosing ratchet storms.

---

## Implementation pattern

In `apps/api/src/observability/metrics.ts`, register all new metrics alongside the existing ones:

```ts
export const wsConnectionsActive = new Gauge({
  name: 'argus_ws_connections_active',
  help: 'Currently authenticated WebSocket connections',
});

export const authAttempts = new Counter({
  name: 'argus_auth_attempts_total',
  help: 'Authentication attempts by result and method',
  labelNames: ['result', 'method'] as const,
});

export const messagesSent = new Counter({
  name: 'argus_messages_sent_total',
  help: 'Messages persisted to the database',
});

export const mlsOperations = new Counter({
  name: 'argus_mls_operations_total',
  help: 'MLS cryptographic operations',
  labelNames: ['op'] as const,
});
```

Then inject `MetricsService` (or import the metric directly) in each service and call `.inc()` / `.dec()` at the relevant points.

---

## Dashboard updates required

- `argus-api-overview.json` panel 7: replace the Loki WS approximation with `argus_ws_connections_active` (Prometheus gauge panel — simpler, accurate, real-time).
- `argus-security.json`: replace the Loki-based auth timeline with `rate(argus_auth_attempts_total[1m])` split by `result` and `method` — a real rate panel.
- `argus-infrastructure.json`: add an MLS operations panel (`rate(argus_mls_operations_total[5m])` by `op`).

---

## Verification

1. `wget -qO- http://api:9090/metrics | grep argus_ws` — should show the gauge.
2. Connect a WebSocket client (authenticated) and verify the gauge increments.
3. Disconnect and verify it decrements.
4. Attempt a failed login and verify `argus_auth_attempts_total{result="failure"}` increments.
5. Reload the overview dashboard — the WS panel should show the live count from Prometheus.
