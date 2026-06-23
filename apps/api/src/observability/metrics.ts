import type { IncomingMessage } from 'node:http';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Prometheus instrumentation for the API (checkpoint 47, Slice A). Threat model: docs/threat-models/
// observability.md. CRITICAL: metrics describe traffic SHAPE only — counts, latencies, process stats. They
// MUST NOT carry message content, keys, tokens, PII, raw paths, IDs, or query strings (invariants #1/#2).
// Labels are a fixed low-cardinality set: HTTP method, the matched ROUTE TEMPLATE (e.g. /conversations/:id/
// messages — never the concrete id), and the numeric status. The registry is served on a SEPARATE INTERNAL
// port (see metrics-server.ts), never via Caddy / the public /api surface.

// A dedicated registry (not the global default) so metrics state is explicit + test-isolatable.
export const registry = new Registry();

// Process metrics (CPU, RSS, event-loop lag, GC, handles) — node internals only, no app data.
collectDefaultMetrics({ register: registry, prefix: 'argus_api_' });

export const httpRequestsTotal = new Counter({
  name: 'argus_api_http_requests_total',
  help: 'Total HTTP requests, labelled by method, matched route template, and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'argus_api_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labelled by method, matched route template, and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  // API-latency-shaped buckets (5ms … 10s).
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
  // Exemplars let Grafana render clickable dots on the p95 panel that open the Tempo trace for that request.
  enableExemplars: true,
});

// The label for a request's route. We use the Express-matched ROUTE TEMPLATE (set on req.route by the router
// once a handler matches), NOT req.url/originalUrl — so concrete ids and query strings never become labels
// (that both leaks data and explodes cardinality). Unmatched requests (404s on arbitrary paths) collapse to a
// single 'unmatched' label so a scanner can't fan label cardinality with junk paths.
export function routeLabel(
  req: IncomingMessage & { route?: { path?: string }; baseUrl?: string },
): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return 'unmatched';
  // Express strips the mount prefix into baseUrl; re-join so nested routers report the full template.
  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  return `${base}${path}` || 'unmatched';
}
