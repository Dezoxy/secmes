import { readFileSync } from 'node:fs';

import * as Sentry from '@sentry/node';

/**
 * Server-side error tracking (#48) — `@sentry/node`, DSN-GATED and DEFAULT-DENY scrubbed. See
 * docs/threat-models/error-tracking.md. The server stays crypto-blind on this path too: a shipped event
 * carries only error type/message/stack + route-TEMPLATE + opaque ids — NEVER message plaintext, MLS/session
 * /device keys, passphrases, auth tokens, full Authorization headers, cookies, request/response bodies, query
 * strings, or presigned URLs (invariant #2).
 *
 * Disabled (a complete no-op — nothing is initialised or sent) whenever SENTRY_DSN / SENTRY_DSN_FILE is unset,
 * which is the default for local dev, CI, and the pre-arming VM. At arming the DSN points at the self-hosted
 * GlitchTip (Sentry-API-compatible); SaaS Sentry EU is the same value swapped.
 */

let enabled = false;

/** True once `initErrorTracking` has wired a DSN; the interceptor skips its work otherwise. */
export function isErrorTrackingEnabled(): boolean {
  return enabled;
}

// SENTRY_DSN is a write-only ingest key (can submit events, cannot read them). Prefer a mounted credential
// file for consistency with the other secrets; fall back to env. Empty/unset ⇒ disabled.
function resolveDsn(): string | undefined {
  const file = process.env.SENTRY_DSN_FILE;
  if (file) {
    // Operator-set deployment path (SENTRY_DSN_FILE / mounted credential), never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(file, 'utf8').trim() || undefined;
  }
  return process.env.SENTRY_DSN?.trim() || undefined;
}

export function initErrorTracking(log?: (msg: string) => void): boolean {
  const dsn = resolveDsn();
  if (!dsn) return false; // DSN-gated: unset ⇒ complete no-op (the secure default)
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.IMAGE_TAG,
    sendDefaultPii: false, // never auto-attach client IP / cookies / user PII
    tracesSampleRate: 0, // errors ONLY — no performance/trace capture (no request data via tracing)
    maxValueLength: 2048, // cap oversized strings before they reach beforeSend (defense in depth)
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  enabled = true;
  // names/status only — never the DSN value (invariant #2)
  log?.('error tracking enabled (DSN configured; events default-deny scrubbed)');
  return true;
}

// --- Default-deny scrubbing -------------------------------------------------------------------------------
// A key whose NAME implies a credential / secret / session material → its value is dropped wholesale.
const SENSITIVE_KEY =
  /(authorization|cookie|set-cookie|x-amz-|amz-sdk|token|secret|passphrase|password|api[-_]?key|apikey|dsn|signature|credential|private|session)/i;
// A string whose VALUE looks like a credential / signed URL → only the matched span is replaced.
const SENSITIVE_VALUE: RegExp[] = [
  // Signed/presigned URLs — redact the WHOLE URL atomically (scheme + host + object-path + every param), so the
  // bucket/object id and access-key-id never ship, not just the signature. Any X-Amz-* / AWSAccessKeyId /
  // Signature param marks the URL.
  /https?:\/\/[^\s"']*[?&](?:X-Amz-[\w-]+|AWSAccessKeyId|Signature)=[^\s"']*/gi,
  /Bearer\s+[\w.\-+/=]+/gi, // bearer tokens
  /eyJ[\w+/=-]+\.[\w+/=-]+\.[\w+/=-]+/g, // JWTs (header.payload.signature; standard or url-safe base64)
  // Fallback for a bare signing query fragment logged without a scheme.
  /[?&](?:X-Amz-[\w-]+|AWSAccessKeyId|Signature)=[^&\s"']+/gi,
];
const REDACTED = '[REDACTED]';
const MAX_STRING = 2048;

function redactString(s: string): string {
  let out = s;
  for (const re of SENSITIVE_VALUE) out = out.replace(re, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

// Recursively redact: a sensitive KEY drops the whole subtree; otherwise scrub string VALUES by shape.
function redactDeep(value: unknown, keyIsSensitive = false): unknown {
  if (keyIsSensitive) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, SENSITIVE_KEY.test(k));
    }
    return out;
  }
  return value;
}

// The only request headers allowed through untouched — none carry secrets or content. Everything else
// (Authorization, Cookie, …) is dropped: default-deny.
const ALLOWED_HEADERS = new Set(['user-agent', 'content-type', 'content-length', 'accept']);

/**
 * `beforeSend`: DEFAULT-DENY. Strip the request payload surface + host/dependency metadata + stack-frame
 * locals, drop URL-bearing breadcrumbs, then recursively redact the ENTIRE event by key-name + value-shape.
 * Redacting the whole event (not hand-picked bags) is the safe posture: a field we didn't enumerate — a
 * stack-frame `vars`, a new context, an integration's `extra` — can't ship a secret, because every string is
 * walked. Structural fields (`event_id` / `timestamp` / `level` / `release` / `sdk` / `contexts.trace` ids)
 * match no sensitive key or value shape, so they survive intact and grouping/transport are unaffected.
 */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.request) {
    // The route TEMPLATE is carried as a tag (set by the interceptor); the raw request surface is dropped.
    delete event.request.data; // body
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.url; // populated path can hold IDs/query
    const headers = event.request.headers;
    if (headers && typeof headers === 'object') {
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (ALLOWED_HEADERS.has(k.toLowerCase()) && typeof v === 'string') safe[k] = v;
      }
      event.request.headers = safe;
    }
  }
  // Host + dependency metadata — not useful here, mildly recon-y. Sentry sets server_name to the VM hostname.
  delete event.server_name;
  delete event.modules;
  // Keep at most an opaque user id (sendDefaultPii:false already suppresses IP/cookies; this drops email/etc.).
  if (event.user) event.user = event.user.id != null ? { id: event.user.id } : {};
  // Stack-frame locals can hold raw secrets/content under benign names the shape/key rules miss — drop them.
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
  }
  // Drop URL-bearing breadcrumbs already attached to the event (belt-and-suspenders vs. beforeBreadcrumb).
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.filter(
      (b) => b.category !== 'http' && b.category !== 'fetch',
    );
  }
  // Whole-event default-deny redaction — every remaining string scrubbed by key-name + value-shape.
  return redactDeep(event) as Sentry.ErrorEvent;
}

/** `beforeBreadcrumb`: drop URL-bearing http/fetch crumbs entirely; redact the rest. */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (breadcrumb.category === 'http' || breadcrumb.category === 'fetch') return null;
  if (typeof breadcrumb.message === 'string') breadcrumb.message = redactString(breadcrumb.message);
  if (breadcrumb.data) breadcrumb.data = redactDeep(breadcrumb.data) as Sentry.Breadcrumb['data'];
  return breadcrumb;
}
