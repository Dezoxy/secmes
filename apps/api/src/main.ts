import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

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
}

void bootstrap();
