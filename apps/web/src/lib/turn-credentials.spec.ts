import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from './api';
import { loadTurnConfig } from './turn-credentials';

const mockFetch = vi.spyOn(api, 'fetchTurnCredentials');

beforeEach(() => {
  vi.resetAllMocks();
});

const MOCK_RESPONSE = {
  iceServers: [
    {
      urls: ['turn:turn.4rgus.com:3478', 'turns:turn.4rgus.com:5349?transport=tcp'],
      username: '1700000000:userId',
      credential: 'hmacbase64secret==',
    },
  ],
  iceTransportPolicy: 'relay' as const,
  ttlSeconds: 600,
};

describe('loadTurnConfig', () => {
  it('maps iceServers to RTCIceServer shape', async () => {
    mockFetch.mockResolvedValue(MOCK_RESPONSE);
    const config = await loadTurnConfig();
    expect(config.iceTransportPolicy).toBe('relay');
    expect(config.iceServers).toHaveLength(1);
    const srv = config.iceServers[0]!;
    expect(srv.urls).toEqual(MOCK_RESPONSE.iceServers[0]!.urls);
    expect(srv.username).toBe(MOCK_RESPONSE.iceServers[0]!.username);
    expect(srv.credential).toBe(MOCK_RESPONSE.iceServers[0]!.credential);
  });

  it('omits username/credential when absent (STUN server)', async () => {
    mockFetch.mockResolvedValue({
      ...MOCK_RESPONSE,
      iceServers: [{ urls: ['stun:stun.4rgus.com:3478'] }],
    });
    const config = await loadTurnConfig();
    const srv = config.iceServers[0]!;
    expect(srv.username).toBeUndefined();
    expect(srv.credential).toBeUndefined();
  });

  it('never passes the credential to console.log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(MOCK_RESPONSE);
    await loadTurnConfig();
    for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
      for (const arg of call) {
        expect(String(arg)).not.toContain('hmacbase64secret');
      }
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('fetches on every call — no caching', async () => {
    mockFetch.mockResolvedValue(MOCK_RESPONSE);
    await loadTurnConfig();
    await loadTurnConfig();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
