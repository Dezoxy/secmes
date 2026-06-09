import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpRequestDuration, httpRequestsTotal, routeLabel } from './metrics.js';

// `express` isn't a direct dependency, so we type the request/response structurally on node:http (Express's
// Request/Response extend these, and Express adds `route`/`baseUrl`). This stays assignable to `app.use(...)`.
type MetricsRequest = IncomingMessage & { route?: { path?: string }; baseUrl?: string };

// Records one HTTP request's count + latency on the response `close` event. We use `close` (not `finish`)
// because it fires for BOTH a completed response AND a client abort/disconnect — `finish` fires only on a
// clean send, so a half-open/aborted request would otherwise never be counted (a blind spot for exactly the
// abusive traffic you want to see) and its timer closure would be retained (slow leak under a flood). `close`
// fires exactly once, so there's no double-count. By then res.statusCode is final (after guards/filters) and
// req.route is the matched template. Labels: method + route template + status only — never the URL/query/body
// (see metrics.ts). Applied globally via app.use() in main.ts; it never touches request/response content.
export function metricsMiddleware(
  req: MetricsRequest,
  res: ServerResponse,
  next: () => void,
): void {
  const start = process.hrtime.bigint();
  res.once('close', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = {
      method: req.method ?? 'UNKNOWN',
      route: routeLabel(req),
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSeconds);
  });
  next();
}
