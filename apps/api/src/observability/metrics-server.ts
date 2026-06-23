import { createServer, type Server } from 'node:http';
import pino from 'pino';
import type { OpenMetricsContentType, Registry } from 'prom-client';
import { pinoConfig } from './logger.js';
import { registry as defaultRegistry } from './metrics.js';

const log = pino({ ...pinoConfig, name: 'Metrics' });

// Serves the Prometheus registry on a SEPARATE internal port (default 9090), distinct from the app's main
// port. Rationale (docs/threat-models/observability.md): /metrics is operational metadata that must stay
// internal — a separate listener is never proxied by Caddy and has no published host port, so only Prometheus
// on the internal Docker network can scrape it. It is NOT a Nest route, so it bypasses the global JWT guard +
// throttler by construction (no public principal can reach it). Only GET /metrics is served; everything else
// 404s. Bind 0.0.0.0 so an in-network scraper reaches it; exposure is bounded by the lack of a published port.
export function startMetricsServer(
  port = Number(process.env.METRICS_PORT ?? 9090),
  register: Registry<OpenMetricsContentType> = defaultRegistry,
): Server {
  const server = createServer((req, res) => {
    // Match the pathname only (ignore any query string), so a scraper appending `?…` still resolves /metrics.
    const path = (req.url ?? '').split('?', 1)[0];
    if (req.method === 'GET' && path === '/metrics') {
      register
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': register.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          // Never leak internals to the scrape response; log the error class only.
          log.error(`metrics scrape failed: ${(err as Error).name}`);
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('metrics unavailable');
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  // A failed metrics listener (e.g. EADDRINUSE) must NOT take down the message API — an unhandled 'error' on
  // the server would throw and crash the process. Log the code + degrade (metrics simply absent until restart).
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error(`metrics server error: ${err.code ?? err.name}`);
  });
  server.listen(port, '0.0.0.0', () => log.info(`metrics listening on :${port}/metrics`));
  return server;
}
