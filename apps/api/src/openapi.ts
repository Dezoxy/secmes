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
  return SwaggerModule.createDocument(app, config);
}
