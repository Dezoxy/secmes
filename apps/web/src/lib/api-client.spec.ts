import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateConversationRequestSchema, ServiceInfoSchema } from '@argus/contracts';

vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import { requestJson, requestStatus } from './api-client';

const token = vi.mocked(accessToken);
const serviceInfo = { service: 'argus-api', version: '0.0.0', status: 'ok' };

describe('typed API client boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    token.mockReset();
  });

  it('attaches auth headers and returns parsed contract data on success', async () => {
    token.mockResolvedValue('tok123');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(serviceInfo), { status: 200 }));

    const result = await requestJson({
      path: '/example',
      responseSchema: ServiceInfoSchema,
    });

    expect(result).toEqual({ ok: true, status: 200, data: serviceInfo });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/example');
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer tok123',
    );
  });

  it('returns a typed HTTP error without reading or exposing response bodies', async () => {
    token.mockResolvedValue('secret-token');
    const body = 'https://storage.example.com/file?sig=do-not-show';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 401 }));

    const result = await requestJson({
      path: '/example',
      responseSchema: ServiceInfoSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('http');
      expect(result.error.status).toBe(401);
      expect(result.error.message).not.toContain('secret-token');
      expect(result.error.message).not.toContain('storage.example.com');
      expect(result.error.message).not.toContain('/example');
    }
  });

  it('returns a validation error when response JSON violates the contract', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ service: 'argus-api', version: '0.0.0', status: 'bad' }), {
        status: 200,
      }),
    );

    const result = await requestJson({
      path: '/example',
      responseSchema: ServiceInfoSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('response-validation');
      expect(result.error.message).not.toContain('bad');
    }
  });

  it('returns a request validation error before fetch when the body violates the contract', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await requestJson({
      path: '/example',
      method: 'POST',
      body: { memberUserIds: ['not-a-uuid'], isDirect: true },
      requestSchema: CreateConversationRequestSchema,
      responseSchema: ServiceInfoSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('request-validation');
      expect(result.error.message).not.toContain('not-a-uuid');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an invalid-json error when a successful response is not JSON', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await requestJson({
      path: '/example',
      responseSchema: ServiceInfoSchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-json');
  });

  it('returns a network error for failed fetches', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline with bearer tok'));

    const result = await requestStatus({
      path: '/auth/session',
      method: 'POST',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.message).not.toContain('tok');
    }
  });
});
