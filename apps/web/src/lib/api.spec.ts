import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the auth module so these tests don't pull in oidc-client-ts and we can control the token.
vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import { apiFetch, establishSession } from './api';

const token = vi.mocked(accessToken);

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    token.mockReset();
  });

  it('attaches the Bearer token and hits the /api proxy path', async () => {
    token.mockResolvedValue('tok123');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/me');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/me');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok123');
  });

  it('omits Authorization when there is no token (demo mode)', async () => {
    token.mockResolvedValue(null);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await apiFetch('/me');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('establishSession POSTs /auth/session then returns the /me profile', async () => {
    token.mockResolvedValue('tok');
    const me = { userId: 'u', tenantId: 't', email: 'a@b.c', displayName: 'A' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(me), { status: 200 }));
    await expect(establishSession()).resolves.toEqual(me);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/auth/session');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/me');
  });

  it('establishSession throws when /me is not ok', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(establishSession()).rejects.toThrow('/me → 401');
  });
});
