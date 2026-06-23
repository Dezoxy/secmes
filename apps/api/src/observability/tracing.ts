// OpenTelemetry SDK bootstrap. Loaded via `node --import` (see Dockerfile CMD) so it runs before
// any application module is imported — the SDK must patch Node built-ins before their first require.
//
// Security constraints (invariant #2):
//  - HTTP spans: url.full / http.url are redacted on ALL spans (incoming and outgoing).
//    Incoming routes are still captured via http.route (set by the NestJS middleware, safe).
//    Outgoing requests — particularly web-push sendNotification() calls — carry capability URLs
//    (push endpoint credentials) that must never be persisted in traces.
//  - pg instrumentation is disabled: the project uses postgres.js (not pg), and even if it fires it
//    would capture SQL text. Disabling removes any risk of query text reaching Tempo.
//  - fs and dns instrumentation are disabled: too noisy for this service.
//  - Sampling: 10% in production via OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG env overrides.
//    The NodeSDK picks these up automatically; no code change needed to adjust sampling.
//  - The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT from env (set to http://tempo:4318 in prod).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'argus-api',
    [ATTR_SERVICE_VERSION]: process.env['IMAGE_TAG'] ?? 'dev',
  }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/healthz',
        // Redact full URLs from every span — outgoing push capability URLs must not persist in traces.
        // http.route (set by the NestJS framework) is untouched and remains useful for dashboards.
        // requestHook covers incoming server spans; applyCustomAttributesOnSpan covers outgoing client
        // spans (belt-and-suspenders: OTel library versions differ on which hook fires for which span kind).
        requestHook: (span) => {
          span.setAttribute('url.full', '[redacted]');
          span.setAttribute('http.url', '[redacted]');
        },
        applyCustomAttributesOnSpan: (span) => {
          span.setAttribute('url.full', '[redacted]');
          span.setAttribute('http.url', '[redacted]');
        },
      },
      '@opentelemetry/instrumentation-pg': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().catch(() => undefined);
});
process.on('SIGINT', () => {
  sdk.shutdown().catch(() => undefined);
});
