// OpenTelemetry SDK bootstrap. Loaded via `node --import` (see Dockerfile CMD) so it runs before
// any application module is imported — the SDK must patch Node built-ins before their first require.
//
// Security constraints (invariant #2):
//  - HTTP auto-instrumentation captures method, route template, status code and duration only.
//    It does NOT capture request/response bodies or auth headers by default — do not add requestHook.
//  - pg instrumentation is disabled: the project uses postgres.js (not pg), and even if it fires it
//    would capture SQL text. Disabling removes any risk of query text reaching Tempo.
//  - fs and dns instrumentation are disabled: too noisy for this service.
//  - Sampling: 10% in production via OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG env overrides.
//    The NodeSDK picks these up automatically; no code change needed to adjust sampling.
//  - The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT from env (set to http://tempo:4318 in prod).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'argus-api',
    [ATTR_SERVICE_VERSION]: process.env['IMAGE_TAG'] ?? 'dev',
  }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/healthz',
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
