import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/** Single source of truth for the API spec that 42Crunch audits. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('secmes API')
    .setDescription(
      'Crypto-blind delivery API for the secmes E2EE messaging platform. ' +
        'Stores and forwards ciphertext only; never message content.',
    )
    .setVersion(process.env.APP_VERSION ?? 'dev')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, config);

  // Invariant 5 / 42Crunch: request bodies must reject unknown properties. @nestjs/swagger has no class
  // decorator for `additionalProperties:false`, so pin it on the input DTO schemas here — keeping the
  // documented contract in lockstep with the Zod `.strict()` the server actually enforces.
  const STRICT_INPUT_SCHEMAS = ['PublishKeyPackagesBody', 'BackupBody'];
  for (const name of STRICT_INPUT_SCHEMAS) {
    const schema = doc.components?.schemas?.[name];
    if (schema && typeof schema === 'object' && !('$ref' in schema)) {
      (schema as { additionalProperties?: boolean }).additionalProperties = false;
    }
  }
  return doc;
}
