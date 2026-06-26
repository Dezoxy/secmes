// tracing.ts MUST be the first import so the OTel SDK patches Node built-ins before any other module
// loads. See docs/threat-models/structured-logging-and-tracing.md and apps/api/Dockerfile CMD.
import './observability/tracing.js';

import 'reflect-metadata';
import pino from 'pino';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule } from '@nestjs/swagger';
import { OLDEST_RETAINED_EPOCH_HEADER } from '@argus/contracts';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';
import { initErrorTracking } from './observability/error-tracking.js';
import { ErrorTrackingInterceptor } from './observability/error-tracking.interceptor.js';
import { metricsMiddleware } from './observability/metrics.middleware.js';
import { startMetricsServer } from './observability/metrics-server.js';
import { pinoConfig } from './observability/logger.js';
import { configureDynamicResponseCaching } from './common/http-cache.js';

// Bootstrap-phase logger for messages emitted before/after the DI container is up.
const bootLog = pino({ ...pinoConfig, name: 'Bootstrap' });

async function bootstrap(): Promise<void> {
  // Error tracking (checkpoint 48) — init as early as possible so captures cover the whole app. DSN-GATED:
  // a complete no-op when SENTRY_DSN is unset (the default until arming). Events are default-deny scrubbed
  // (no content/keys/tokens/headers/presigned URLs ever leave — see observability/error-tracking.ts).
  initErrorTracking((msg) => bootLog.info({ context: 'ErrorTracking' }, msg));

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // Switch NestJS's internal logger to the Pino logger provisioned by LoggerModule, flushing any
  // buffered boot-phase logs through Pino.
  app.useLogger(app.get(Logger));

  // Dynamic authenticated API responses must never return 304/not-modified. Polling endpoints such as
  // GET /welcomes carry per-device join metadata and a 304 response has no JSON body for the client to drain.
  configureDynamicResponseCaching(app);

  // Report unhandled/5xx errors to Sentry/GlitchTip without altering the response (observe + rethrow). No-op
  // when error tracking is disabled. Captures method + route-template + opaque ids only.
  app.useGlobalInterceptors(new ErrorTrackingInterceptor());

  // Content-blind HTTP metrics (checkpoint 47): records count + latency per {method, route-template, status}
  // on the main server. The metrics themselves are exposed on a SEPARATE internal port below, not here.
  app.use(metricsMiddleware);

  // Native WebSocket gateway (no socket.io) for real-time ciphertext delivery (checkpoint 28). The
  // gateway authenticates each socket with a first-frame token; the global HTTP guard skips WS.
  app.useWebSocketAdapter(new WsAdapter(app));

  // Cookie parsing (Phase 1: HttpOnly refresh cookie for session rotation).
  app.use(cookieParser());

  // CORS — locked to the configured frontend origin. Credentials required for the refresh cookie.
  // X-Argus-Refresh is the CSRF defense-in-depth header; must be in allowedHeaders.
  // Never echo arbitrary origins or use a wildcard with credentials.
  const frontendOrigin = process.env['FRONTEND_ORIGIN'] ?? 'http://localhost:5173';
  // exposedHeaders: custom response headers are invisible to the browser's fetch() unless explicitly
  // exposed. X-Oldest-Retained-Epoch (GET /commits) carries the sync-lost signal the web client reads.
  app.enableCors({
    origin: frontendOrigin,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Argus-Refresh', 'X-Confirm-Delete'],
    exposedHeaders: [OLDEST_RETAINED_EPOCH_HEADER],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // Trust exactly the deployment's proxy hop count (ingress/LB) so req.ip reflects the real client
  // in audit metadata. Driven by env so a topology change (added CDN/WAF) can't silently corrupt
  // the audit IP. Never `true` — that lets clients spoof X-Forwarded-For.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.set(
    'trust proxy',
    Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1,
  );

  // Graceful shutdown for clean pod termination.
  app.enableShutdownHooks();

  // Serve interactive API docs outside production only.
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, createOpenApiDocument(app));
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  bootLog.info({ port }, 'api listening');

  // Prometheus metrics on a SEPARATE internal port (default 9090) — never routed by Caddy / the public /api
  // surface, no published host port, so only an in-network scraper reaches it (see observability.md). Closed
  // on the same termination signals Nest's shutdown hooks use, so the listener doesn't linger.
  const metricsServer = startMetricsServer();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => metricsServer.close());
  }
}

void bootstrap();
