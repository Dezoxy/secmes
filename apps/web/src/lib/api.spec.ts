import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the auth module so these tests don't pull in oidc-client-ts and we can control the token.
vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import {
  apiFetch,
  claimKeyPackage,
  createConversation,
  deliverWelcome,
  establishSession,
  listUsers,
  publishKeyPackages,
} from './api';

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

  it('publishKeyPackages POSTs the device public material to the directory', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ deviceId: 'd', published: 2 }), { status: 200 }),
      );
    const res = await publishKeyPackages('sigpub==', ['kpA', 'kpB']);
    expect(res).toEqual({ deviceId: 'd', published: 2 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/devices/me/key-packages');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      signaturePublicKey: 'sigpub==',
      keyPackages: ['kpA', 'kpB'],
    });
  });

  it('publishKeyPackages throws on a non-ok response', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));
    await expect(publishKeyPackages('s', ['k'])).rejects.toThrow('key-packages → 400');
  });

  it('listUsers GETs /users with the limit and returns the directory', async () => {
    token.mockResolvedValue('tok');
    const users = [{ id: 'u1', email: 'a@b.c', displayName: 'A' }];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(users), { status: 200 }));
    await expect(listUsers(25)).resolves.toEqual(users);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/users?limit=25');
  });

  it('claimKeyPackage POSTs the claim and surfaces an empty pool (404) distinctly', async () => {
    token.mockResolvedValue('tok');
    const claimed = { deviceId: 'd', signaturePublicKey: 's', keyPackage: 'kp' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(claimed), { status: 200 }));
    await expect(claimKeyPackage('peer-1')).resolves.toEqual(claimed);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/users/peer-1/key-package/claim');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('none', { status: 404 }));
    await expect(claimKeyPackage('peer-1')).rejects.toThrow('no key packages available');
  });

  it('createConversation POSTs the member ids', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ conversationId: 'c1' }), { status: 201 }));
    await expect(createConversation(['u2'])).resolves.toEqual({ conversationId: 'c1' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/conversations');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      memberUserIds: ['u2'],
    });
  });

  it('deliverWelcome POSTs the opaque Welcome to the conversation', async () => {
    token.mockResolvedValue('tok');
    const body = { recipientUserId: 'u2', recipientDeviceId: 'd2', welcome: 'w', ratchetTree: 'r' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ welcomeId: 'wel1' }), { status: 201 }));
    await expect(deliverWelcome('c1', body)).resolves.toEqual({ welcomeId: 'wel1' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/conversations/c1/welcomes');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual(body);
  });
});
