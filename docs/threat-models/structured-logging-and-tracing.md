# Threat model: structured logging & distributed tracing

> Status: **DRAFT for ratification.** Covers two additions to the observability stack:
> (1) structured JSON logging via Pino → Loki, replacing the plain-text NestJS built-in Logger;
> (2) distributed tracing via OpenTelemetry → Grafana Tempo. Extends `observability.md` (metrics) and
> `centralized-logs.md` (Loki/Alloy pipeline).

## 1. Feature & data flows

### 1a. Structured logging

```
api (Pino JSON to stdout)
  ├── level, context, reqId, msg, trace_id, span_id  ← safe metadata fields
  └── serializers.req strips query string (presigned-URL params)
      redact list masks: authorization header, cookies, *.token/password/secret/key/dsn
           │
           ▼  Docker json-file log
Alloy (reads /var/lib/docker/containers/*-json.log, read-only, no socket)
  ├── outer JSON parse: log, stream, time
  ├── inner JSON parse (new): level, context, reqId, trace_id, span_id
  ├── stream labels: level, context (low-cardinality)
  ├── structured metadata: reqId, trace_id, span_id (high-cardinality, per-line)
  └── scrub stage (defense-in-depth): masks bearer tokens, JWTs, presigned URLs, 40+ char opaque tokens
           │
           ▼
Loki (7-day retention) ←──── Grafana (internal, behind Cloudflare Access)
```

### 1b. Distributed tracing

```
api (OpenTelemetry SDK loaded via --import before any module)
  ├── auto-instrumentation: HTTP server/client spans, NestJS decorator spans
  ├── NO SQL spans: postgres.js has no OTel instrumentation; no query text captured
  ├── NO request/response body capture: default auto-instrumentation does not record payloads
  └── span attributes: http.method, http.route (template), http.status_code, duration only
           │ OTLP HTTP (internal Docker network, port 4318)
           ▼
Tempo (internal, no published port, 72h retention, filesystem backend)
           │ internal HTTP port 3200
           ▼
Grafana (trace viewer, linked from Loki log lines via trace_id derived field)
```

## 2. Assets & trust boundaries

- **Loki structured metadata** (reqId, trace_id, span_id): opaque identifiers, no content meaning.
- **Tempo spans**: route templates + status codes + durations only; no bodies, no SQL, no headers.
- **Pino logger config**: `redact` and `serializers.req` are first-party controls; Alloy scrub is second.
- **Tempo service**: internal only (no published port). Same posture as Loki/Prometheus: reachable only
  by Grafana over the Docker internal network.
- **`OTEL_EXPORTER_OTLP_ENDPOINT`**: a non-secret internal address (`http://tempo:4318`); env var, not a
  secret file. Same pattern as `FRONTEND_ORIGIN` and `WEBAUTHN_RP_ID` — public configuration.

## 3. Threats (STRIDE-lite)

- **Information disclosure (primary risk):**
  - Pino `serializers.req` MUST strip the query string from `req.url` before the URL reaches any log
    sink. Presigned B2/S3 URLs carry `X-Amz-Signature`, `AWSAccessKeyId`, and `X-Amz-Security-Token`
    as query params — if logged verbatim, a log-reader gains object access for the signature's TTL.
    **Control**: `req.url?.split('?')[0]` in the serializer; covered by `logger.spec.ts`.
  - OTel spans must not capture request or response bodies. The `@opentelemetry/instrumentation-http`
    auto-instrumentation does NOT capture bodies by default — do NOT override `requestHook` or
    `responseHook` to add body-derived attributes.
  - `@opentelemetry/instrumentation-pg` is explicitly disabled (the project uses `postgres.js`, not `pg`,
    so the instrumentation would not fire anyway; disabling avoids accidental future SQL capture if the
    driver is ever swapped).
  - Alloy's 40+ char scrub rule does NOT redact trace IDs (32 hex chars) or request UUIDs (36 chars
    including hyphens) — both are below the 40-char threshold and are hex-only strings with no content.
- **Spoofing:** Tempo and Loki are internal-only (no published ports, no auth). Adding a host-port
  mapping or routing them through Caddy would expose the ingest APIs publicly. Guarded by the same
  comment + no-published-ports convention as Prometheus.
- **Tampering / cardinality:** `level` and `context` are Loki stream labels; their value space is
  bounded (7 log levels, ~20 service contexts). High-cardinality fields (reqId, trace_id, span_id) go
  into Loki structured metadata, not stream labels, staying under `max_streams_per_user: 5000`.
- **Resource exhaustion (Tempo):** 72h retention + 512m memory limit. Adjust based on real trace volume.

## 4. Invariant check

1. **Server crypto-blind** — Pino logs IDs/metadata only; span attributes are route templates, status
   codes, durations. No message content, keys, or ciphertext appears in any log or span. ✔
2. **No secret/content logging or persistence** — `redact` list + `serializers.req` query-stripping at
   the Pino level; Alloy scrub as defense-in-depth; OTel HTTP auto-instrumentation does not capture
   bodies or auth headers by default. Covered by `logger.spec.ts` assertions. ✔
3. **Tenant isolation** — trace IDs and request IDs are opaque per-request UUIDs; they carry no tenant
   meaning. Loki stream labels (`level`, `context`) are also content-free. No per-tenant stream
   splitting (cardinality safety). ✔
4. **No hand-rolled crypto** — N/A to logging/tracing. ✔
5. **Secrets via Key Vault** — `OTEL_EXPORTER_OTLP_ENDPOINT` is a non-secret internal address in env.
   No secret values in the logging or tracing config. ✔
6. **No admin path to content** — Grafana log and trace panels show route templates, status codes,
   durations, log messages (which by AGENTS.md invariant contain IDs/metadata only). Never message text
   or images. ✔

## 5. Decision & mitigations

**Structured logging:** Replace `@nestjs/common` Logger with `nestjs-pino`. The `serializers.req`
query-stripping and `redact` list are the primary controls; Alloy scrub is the safety net. The `mixin`
function injects `trace_id`/`span_id` from the active OTel span, enabling log-to-trace navigation in
Grafana.

**Distributed tracing:** Load the OTel SDK via `node --import ./dist/observability/tracing.js` (ESM
`--import` flag in the Dockerfile CMD), ensuring the SDK patches Node built-ins before any app module
is imported. 10% tail sampling in production (`OTEL_TRACES_SAMPLER_ARG=0.1`), overridable via env.

**Gate:** `infra-reviewer` (Tempo container hardening, no published port); `security-boundary-auditor`
(no content/secret in spans or log lines, no SQL text in spans).

## 6. Residual risk

- **`postgres.js` has no OTel instrumentation** — DB-level spans (query count, latency per operation)
  are absent. HTTP spans cover the request-level latency; Prometheus histograms cover per-route
  latency. DB instrumentation can be added if the driver is swapped or a wrapper is built.
- **10% sampling** means 90% of traces are dropped in production. A high-latency or error trace may
  not be sampled. Adjust `OTEL_TRACES_SAMPLER_ARG` to 1.0 for debugging a specific issue.
- **Tempo retention is 72h** — forensic trace analysis is limited to the past 3 days. Increase at
  arming if storage allows.
- **Pino `redact` uses path matching**, not deep regex. A new field added to a log call that stores a
  secret under an unexpected key name (not `*.token` etc.) would slip through. The Semgrep
  `argus-no-secret-logging` rule and code review are the backstop for application-level discipline.
