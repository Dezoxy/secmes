import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';

/** Emit apps/api/openapi.json without starting a server (used by CI + the /api-spec skill). */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = createOpenApiDocument(app);
  const out = join(process.cwd(), 'openapi.json');
  // Path is process-controlled (cwd + literal filename), never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(out, JSON.stringify(document, null, 2));
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`wrote ${out}`);
}

void main();
