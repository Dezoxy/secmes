// Shared Pino logger configuration. Consumed by LoggerModule (nestjs-pino) and standalone pino
// instances for module-level factory code that runs outside the DI container.
//
// Security controls (invariant #2):
//  - serializers.req strips the query string — presigned B2/S3 URLs carry signing params as query.
//  - redact masks auth headers, cookies, and common secret field names at the pino level.
//  - Alloy's scrub stage is a second layer; these are the primary application controls.
//  - otelMixin injects trace_id/span_id (opaque hex IDs, no content meaning) for log-trace linking.
import { randomUUID } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';

function otelMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

export const pinoConfig: LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
  messageKey: 'msg',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: ['*.token', '*.password', '*.secret', '*.key', '*.dsn'],
  mixin: otelMixin,
};

export const pinoHttpConfig: PinoHttpOptions = {
  ...pinoConfig,
  serializers: {
    req(req: IncomingMessage & { url?: string; method?: string }) {
      return {
        method: req.method,
        url: req.url?.split('?')[0] ?? '',
      };
    },
    res(res: ServerResponse) {
      return { statusCode: res.statusCode };
    },
  },
  redact: [
    ...(pinoConfig.redact as string[]),
    'req.headers.authorization',
    'req.headers.cookie',
    'req.query',
  ],
  genReqId(req: IncomingMessage) {
    const incoming = req.headers?.['x-request-id'];
    if (typeof incoming === 'string') {
      const sanitized = incoming.replace(/[^a-f0-9-]/gi, '').slice(0, 36);
      return sanitized || randomUUID();
    }
    return randomUUID();
  },
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === '/healthz',
  },
  customLogLevel(_req: IncomingMessage, res: ServerResponse) {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
};
