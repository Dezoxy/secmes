import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpRequestDuration, httpRequestsTotal, registry, routeLabel } from './metrics.js';
import { metricsMiddleware } from './metrics.middleware.js';

type MetricsRequest = IncomingMessage & {
  route?: { path?: string };
  baseUrl?: string;
  url?: string;
};

function fakeReq(over: Partial<MetricsRequest>): MetricsRequest {
  return { method: 'GET', ...over } as MetricsRequest;
}

// A minimal response stub that emits `close` like a real http.ServerResponse (fires on completion AND abort).
function fakeRes(statusCode: number): ServerResponse & { emitClose: () => void } {
  const ee = new EventEmitter();
  const res = ee as unknown as ServerResponse & { emitClose: () => void };
  res.statusCode = statusCode;
  res.emitClose = () => ee.emit('close');
  return res;
}

beforeEach(() => {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();
});
afterEach(() => {
  httpRequestsTotal.reset();
  httpRequestDuration.reset();
});

describe('routeLabel', () => {
  it('returns the matched route template, joined with the mount prefix', () => {
    expect(
      routeLabel(fakeReq({ route: { path: '/messages' }, baseUrl: '/conversations/:id' })),
    ).toBe('/conversations/:id/messages');
  });

  it('never reflects the concrete URL/query — only the template', () => {
    const req = fakeReq({
      route: { path: '/:id/messages' },
      baseUrl: '/conversations',
      url: '/conversations/3f9b.../messages?cursor=secret-token',
    });
    expect(routeLabel(req)).toBe('/conversations/:id/messages');
  });

  it('collapses unmatched requests to a single bounded label', () => {
    expect(routeLabel(fakeReq({}))).toBe('unmatched');
    expect(routeLabel(fakeReq({ route: { path: '' } }))).toBe('unmatched');
  });
});

describe('metricsMiddleware', () => {
  const noop = (): void => undefined;

  it('records a count + duration with method/route/status labels on finish', async () => {
    const req = fakeReq({
      method: 'POST',
      route: { path: '/:id/messages' },
      baseUrl: '/conversations',
    });
    const res = fakeRes(201);
    metricsMiddleware(req, res, noop);
    res.emitClose();

    const scrape = await registry.metrics();
    expect(scrape).toContain(
      'argus_api_http_requests_total{method="POST",route="/conversations/:id/messages",status="201"} 1',
    );
    expect(scrape).toContain('argus_api_http_request_duration_seconds_count{');
  });

  it('calls next() synchronously (never blocks the request)', () => {
    let called = false;
    metricsMiddleware(fakeReq({}), fakeRes(200), () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('LEAK GUARD: a request with an id + query in its URL exposes neither in the scrape', async () => {
    const uuid = '3f9b2c14-0000-4000-a000-000000000001';
    const req = fakeReq({
      method: 'GET',
      route: { path: '/:id/messages' },
      baseUrl: '/conversations',
      url: `/conversations/${uuid}/messages?cursor=eyJhbGciOi&token=sk_live_secret`,
      headers: { authorization: 'Bearer sk_live_secret' } as IncomingMessage['headers'],
    });
    const res = fakeRes(200);
    metricsMiddleware(req, res, noop);
    res.emitClose();

    const scrape = await registry.metrics();
    expect(scrape).toContain('route="/conversations/:id/messages"'); // the template is present
    expect(scrape).not.toContain(uuid); // …but never the concrete id
    expect(scrape).not.toContain('cursor');
    expect(scrape).not.toContain('sk_live_secret');
    expect(scrape).not.toContain('Bearer');
  });
});

describe('registry', () => {
  it('exposes process metrics but no app content', async () => {
    const scrape = await registry.metrics();
    expect(scrape).toContain('argus_api_process_cpu_seconds_total');
    expect(scrape).toContain('argus_api_nodejs_eventloop_lag_seconds');
  });
});
