import { HttpException, HttpStatus } from '@nestjs/common';
import type { Breadcrumb, ErrorEvent } from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initErrorTracking,
  isErrorTrackingEnabled,
  scrubBreadcrumb,
  scrubEvent,
} from './error-tracking.js';
import { shouldCapture } from './error-tracking.interceptor.js';

// Invariant #2: error tracking is a form of logging — a shipped event must NEVER carry plaintext content,
// keys, tokens, full Authorization headers, cookies, request bodies/query, or presigned URLs. These tests
// pin the default-deny scrubbing that enforces it. See docs/threat-models/error-tracking.md.
describe('scrubEvent — request surface is stripped', () => {
  it('drops body / query / cookies / url and all non-allowlisted headers', () => {
    const event = {
      request: {
        method: 'POST',
        url: 'https://4rgus.com/conversations/abc-123/messages?token=leak',
        query_string: 'token=leak',
        data: { ciphertext: 'SECRET-PLAINTEXT', passphrase: 'hunter2' },
        cookies: 'session=abc',
        headers: {
          authorization: 'Bearer super.secret.jwt',
          cookie: 'session=abc',
          'user-agent': 'argus/1.0',
          'content-type': 'application/json',
        },
      },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event) as ErrorEvent;

    expect(out.request?.data).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.url).toBeUndefined();
    expect(out.request?.headers).toEqual({
      'user-agent': 'argus/1.0',
      'content-type': 'application/json',
    });
    // no Authorization / Cookie survives
    expect(JSON.stringify(out)).not.toMatch(/super\.secret\.jwt/);
    expect(JSON.stringify(out)).not.toMatch(/SECRET-PLAINTEXT/);
  });
});

describe('scrubEvent — recursive redaction of extra/contexts/tags', () => {
  it('drops values under sensitive KEYS (nested), keeps benign ones', () => {
    const event = {
      extra: {
        password: 'hunter2',
        sessionKey: 'AAAA-device-key',
        nested: { apiToken: 'tok_live_123', note: 'benign' },
        count: 7,
      },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event) as ErrorEvent;
    const extra = out.extra as Record<string, unknown>;

    expect(extra.password).toBe('[REDACTED]');
    expect(extra.sessionKey).toBe('[REDACTED]');
    expect((extra.nested as Record<string, unknown>).apiToken).toBe('[REDACTED]');
    expect((extra.nested as Record<string, unknown>).note).toBe('benign');
    expect(extra.count).toBe(7);
  });

  it('redacts generic *key-named fields by KEY NAME (value need not be value-shaped)', () => {
    // Redaction keys on the field NAME, so the fixture values are deliberately non-secret-shaped (real key
    // material would be base64 that the value regexes don't match — which is exactly why key-name matching
    // matters). Plain strings here also keep the secret-scanner quiet.
    const event = {
      extra: {
        key: 'KEY-MATERIAL-PLACEHOLDER',
        messageKey: 'MSG-KEY-PLACEHOLDER',
        deviceKey: 'DEV-KEY-PLACEHOLDER',
        count: 3,
      },
    } as unknown as ErrorEvent;
    const extra = (scrubEvent(event) as ErrorEvent).extra as Record<string, unknown>;
    expect(extra.key).toBe('[REDACTED]');
    expect(extra.messageKey).toBe('[REDACTED]');
    expect(extra.deviceKey).toBe('[REDACTED]');
    expect(extra.count).toBe(3);
  });

  it('redacts credential-shaped VALUES even under a benign key', () => {
    const event = {
      extra: {
        detailBearer: 'failed call, header was Bearer abc.def-ghi/jk',
        detailJwt: 'token eyJhbGciOi.eyJzdWIiOi.SiGnAtUrE here',
        detailUrl: 'GET https://b2.example/obj?X-Amz-Signature=deadbeef&x=1 failed',
      },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event) as ErrorEvent;
    const extra = out.extra as Record<string, string>;

    expect(extra.detailBearer).toBe('failed call, header was [REDACTED]');
    expect(extra.detailJwt).toContain('[REDACTED]');
    expect(extra.detailJwt).not.toMatch(/eyJ/);
    expect(extra.detailUrl).not.toMatch(/X-Amz-Signature=deadbeef/);
  });
});

describe('scrubEvent — user, exception message, event message', () => {
  it('keeps only an opaque user id', () => {
    const event = {
      user: { id: 'u-1', email: 'a@b.com', ip_address: '1.2.3.4', username: 'alice' },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event) as ErrorEvent;
    expect(out.user).toEqual({ id: 'u-1' });
  });

  it('redacts a token leaked into an exception value or the event message', () => {
    const event = {
      message: 'auth failed with Bearer abc.def.ghi',
      exception: { values: [{ type: 'Error', value: 'bad jwt eyJaaa.bBB.cCC seen' }] },
    } as unknown as ErrorEvent;
    const out = scrubEvent(event) as ErrorEvent;
    expect(out.message).toBe('auth failed with [REDACTED]');
    expect(out.exception?.values?.[0]?.value).toContain('[REDACTED]');
    expect(out.exception?.values?.[0]?.value).not.toMatch(/eyJ/);
  });
});

describe('scrubEvent — whole-event default-deny (no bag escapes)', () => {
  it('strips secrets from EVERY field and preserves structural ones', () => {
    const event = {
      event_id: 'abc123def456',
      level: 'error',
      release: 'deadbeef',
      platform: 'node',
      server_name: 'argus-vm-prod',
      modules: { '@argus/crypto': '1.0.0' },
      request: {
        url: 'https://4rgus.com/conversations/c-1/messages?x=1',
        data: { ciphertext: 'PLAINTEXT-LEAK-1' },
        headers: { authorization: 'Bearer aaa.bbb.ccc', 'user-agent': 'argus/1.0' },
      },
      user: { id: 'u-1', email: 'a@b.com' },
      tags: { sessionKey: 'KEY-LEAK-2', 'http.route': '/messages' },
      contexts: {
        custom: { passphrase: 'PASS-LEAK-3' },
        trace: { trace_id: 'f'.repeat(32), span_id: 'a'.repeat(16) },
      },
      extra: {
        note: 'see https://b2.example/bucket/obj-9?X-Amz-Signature=sig123&X-Amz-Credential=AKIAKEY',
      },
      breadcrumbs: [
        { category: 'http', data: { url: 'https://x/y?id=1' } },
        { category: 'auth', data: { token: 'TOK-LEAK-4' } },
      ],
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom with eyJh.eyJp.sig',
            stacktrace: {
              frames: [{ filename: 'svc.ts', vars: { devicePassphrase: 'VARS-LEAK-5' } }],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const dump = JSON.stringify(scrubEvent(event));

    for (const secret of [
      'PLAINTEXT-LEAK-1', // request body
      'KEY-LEAK-2', // tag under a sensitive key
      'PASS-LEAK-3', // nested custom context
      'TOK-LEAK-4', // breadcrumb data
      'VARS-LEAK-5', // stack-frame locals
      'Bearer aaa', // Authorization header
      'aaa.bbb.ccc',
      'a@b.com', // user email
      'argus-vm-prod', // server_name
      'bucket/obj-9', // presigned URL object path (atomic redaction)
      'X-Amz-Signature',
      'AKIAKEY',
      'sig123',
      'eyJh.eyJp.sig', // JWT in exception message
    ]) {
      expect(dump).not.toContain(secret);
    }
    // Structural fields the SDK needs for grouping/transport must survive.
    expect(dump).toContain('abc123def456'); // event_id
    expect(dump).toContain('"level":"error"');
    expect(dump).toContain('deadbeef'); // release
    expect(dump).toContain('f'.repeat(32)); // contexts.trace.trace_id preserved
    expect(dump).toContain('http.route'); // benign tag key survives
  });
});

describe('scrubBreadcrumb', () => {
  it('drops URL-bearing http/fetch breadcrumbs entirely', () => {
    expect(
      scrubBreadcrumb({ category: 'http', data: { url: 'https://x/y?id=1' } } as Breadcrumb),
    ).toBeNull();
    expect(scrubBreadcrumb({ category: 'fetch' } as Breadcrumb)).toBeNull();
  });

  it('redacts other breadcrumbs by key and message', () => {
    const out = scrubBreadcrumb({
      category: 'auth',
      message: 'used Bearer abc.def.ghi',
      data: { token: 't', ok: 'yes' },
    } as Breadcrumb) as Breadcrumb;
    expect(out.message).toBe('used [REDACTED]');
    expect((out.data as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((out.data as Record<string, unknown>).ok).toBe('yes');
  });
});

describe('shouldCapture — only genuine server faults', () => {
  it('skips 4xx client errors', () => {
    expect(shouldCapture(new HttpException('bad', HttpStatus.BAD_REQUEST))).toBe(false);
    expect(shouldCapture(new HttpException('unauth', HttpStatus.UNAUTHORIZED))).toBe(false);
    expect(shouldCapture(new HttpException('too many', HttpStatus.TOO_MANY_REQUESTS))).toBe(false);
  });
  it('captures 5xx + unhandled', () => {
    expect(shouldCapture(new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR))).toBe(true);
    expect(shouldCapture(new Error('unexpected'))).toBe(true);
    expect(shouldCapture('weird non-error throw')).toBe(true);
  });
});

describe('initErrorTracking — DSN-gated (secure default = disabled)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN_FILE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is a no-op and reports disabled when no DSN is configured', () => {
    expect(initErrorTracking()).toBe(false);
    expect(isErrorTrackingEnabled()).toBe(false);
  });
});
