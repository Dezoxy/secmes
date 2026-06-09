import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';
import { metricsMiddleware } from './observability/metrics.middleware.js';
import { startMetricsServer } from './observability/metrics-server.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  // Content-blind HTTP metrics (checkpoint 47): records count + latency per {method, route-template, status}
  // on the main server. The metrics themselves are exposed on a SEPARATE internal port below, not here.
  app.use(metricsMiddleware);

  // Native WebSocket gateway (no socket.io) for real-time ciphertext delivery (checkpoint 28). The
  // gateway authenticates each socket with a first-frame token; the global HTTP guard skips WS.
  app.useWebSocketAdapter(new WsAdapter(app));

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
  Logger.log(`api listening on :${port}`, 'Bootstrap');

  // Prometheus metrics on a SEPARATE internal port (default 9090) — never routed by Caddy / the public /api
  // surface, no published host port, so only an in-network scraper reaches it (see observability.md). Closed
  // on the same termination signals Nest's shutdown hooks use, so the listener doesn't linger.
  const metricsServer = startMetricsServer();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => metricsServer.close());
  }
}

void bootstrap();
