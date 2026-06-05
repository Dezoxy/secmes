import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

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
