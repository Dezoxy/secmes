import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the auth module so these tests don't pull in oidc-client-ts and we can control the token.
vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import {
  apiFetch,
  claimKeyPackage,
  consumeWelcome,
  createConversation,
  deliverWelcome,
  establishSession,
  fetchWelcomeMaterial,
  listUsers,
  listWelcomes,
  publishKeyPackages,
  revokeKeyPackages,
} from './api';

const token = vi.mocked(accessToken);
const userId = '00000000-0000-4000-8000-000000000001';
const tenantId = '00000000-0000-4000-8000-000000000002';
const peerUserId = '00000000-0000-4000-8000-000000000003';
const deviceId = '00000000-0000-4000-8000-000000000004';
const peerDeviceId = '00000000-0000-4000-8000-000000000005';
const conversationId = '00000000-0000-4000-8000-000000000006';
const welcomeId = '00000000-0000-4000-8000-000000000007';

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
    const me = { userId, tenantId, email: 'alice@example.com', displayName: 'A' };
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
    await expect(establishSession()).rejects.toThrow('API request failed with status 401.');
  });

  it('publishKeyPackages POSTs the device public material to the directory', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ deviceId, published: 2, available: 8 }), { status: 200 }),
      );
    const res = await publishKeyPackages('sigpub==', ['kpA', 'kpB']);
    expect(res).toEqual({ deviceId, published: 2, available: 8 });
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
    await expect(publishKeyPackages('s', ['k'])).rejects.toThrow(
      'API request failed with status 400.',
    );
  });

  it('revokeKeyPackages POSTs the device sig key to the revoke route', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ revoked: 3 }), { status: 200 }));
    const res = await revokeKeyPackages('sigpub==');
    expect(res).toEqual({ revoked: 3 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/devices/me/key-packages/revoke');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ signaturePublicKey: 'sigpub==' });
  });

  it('revokeKeyPackages throws on a non-ok response', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(revokeKeyPackages('s')).rejects.toThrow('API request failed with status 500.');
  });

  it('listUsers GETs /users with the limit and returns the directory', async () => {
    token.mockResolvedValue('tok');
    const users = [{ id: 'u1', email: 'alice@example.com', displayName: 'A' }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(users), { status: 200 }),
    );
    await expect(listUsers(25)).rejects.toThrow(
      'API response did not match the expected contract.',
    );
  });

  it('listUsers validates and returns the tenant directory', async () => {
    token.mockResolvedValue('tok');
    const users = [{ id: peerUserId, email: 'alice@example.com', displayName: 'A' }];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(users), { status: 200 }));
    await expect(listUsers(25)).resolves.toEqual(users);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/users?limit=25');
  });

  it('claimKeyPackage POSTs the claim and surfaces an empty pool (404) distinctly', async () => {
    token.mockResolvedValue('tok');
    const claimed = { deviceId, signaturePublicKey: 's', keyPackage: 'kp' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(claimed), { status: 200 }));
    await expect(claimKeyPackage(peerUserId)).resolves.toEqual(claimed);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`/api/users/${peerUserId}/key-package/claim`);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('none', { status: 404 }));
    await expect(claimKeyPackage(peerUserId)).rejects.toThrow('no key packages available');
  });

  it('createConversation POSTs the member ids', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ conversationId }), { status: 201 }));
    await expect(createConversation([peerUserId])).resolves.toEqual({ conversationId });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/conversations');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      memberUserIds: [peerUserId],
    });
  });

  it('deliverWelcome POSTs the opaque Welcome to the conversation', async () => {
    token.mockResolvedValue('tok');
    const body = {
      recipientUserId: peerUserId,
      recipientDeviceId: peerDeviceId,
      welcome: 'w',
      ratchetTree: 'r',
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ welcomeId }), { status: 201 }));
    await expect(deliverWelcome(conversationId, body)).resolves.toEqual({ welcomeId });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`/api/conversations/${conversationId}/welcomes`);
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual(body);
  });

  it('listWelcomes GETs this device pending welcomes with deviceId + limit', async () => {
    token.mockResolvedValue('tok');
    const welcomes = [{ id: welcomeId, conversationId, createdAt: '2026-01-01T00:00:00.000Z' }];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(welcomes), { status: 200 }));
    await expect(listWelcomes(deviceId, 20)).resolves.toEqual(welcomes);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`/api/welcomes?deviceId=${deviceId}&limit=20`);
  });

  it('fetchWelcomeMaterial GETs the sealed material with the base64url proof', async () => {
    token.mockResolvedValue('tok');
    const material = { welcome: 'w', ratchetTree: 'r' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(material), { status: 200 }));
    await expect(fetchWelcomeMaterial(welcomeId, deviceId, 'pf-_')).resolves.toEqual(material);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `/api/welcomes/${welcomeId}/material?deviceId=${deviceId}&proof=pf-_`,
    );
  });

  it('consumeWelcome DELETEs the welcome with the proof (204 ok)', async () => {
    token.mockResolvedValue('tok');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(consumeWelcome(welcomeId, deviceId, 'pf')).resolves.toBeUndefined();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `/api/welcomes/${welcomeId}?deviceId=${deviceId}&proof=pf`,
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('consumeWelcome throws on a non-ok response', async () => {
    token.mockResolvedValue('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(consumeWelcome(welcomeId, deviceId, 'pf')).rejects.toThrow(
      'API request failed with status 404.',
    );
  });
});
