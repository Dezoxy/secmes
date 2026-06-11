import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}));

import { savePushSubscription, deletePushSubscription } from './api';
import { subscribeToPush, unsubscribeFromPush } from './push';

const save = vi.mocked(savePushSubscription);
const del = vi.mocked(deletePushSubscription);

const VAPID_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DEVICE_ID = '00000000-0000-0000-0000-000000000001';

const requestPermissionMock = vi.fn<() => Promise<NotificationPermission>>();

function makeSubObject(unsubscribeFn = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)) {
  return {
    endpoint: 'https://push.example.com/sub-1',
    getKey: (key: string) =>
      key === 'p256dh' ? new Uint8Array(32).buffer : new Uint8Array(16).buffer,
    unsubscribe: unsubscribeFn,
  };
}

function setupServiceWorker(sub: ReturnType<typeof makeSubObject> | null = makeSubObject()) {
  const subscribe = vi.fn().mockResolvedValue(sub);
  const getSubscription = vi.fn().mockResolvedValue(sub);
  const ready = Promise.resolve({ pushManager: { subscribe, getSubscription } });
  vi.stubGlobal('navigator', { serviceWorker: { ready } });
  return { subscribe, getSubscription };
}

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue(undefined);
  del.mockResolvedValue(undefined);
  requestPermissionMock.mockResolvedValue('granted');
  vi.stubGlobal('PushManager', class PushManager {});
  vi.stubGlobal('Notification', { requestPermission: requestPermissionMock });
  setupServiceWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('subscribeToPush', () => {
  it('requests permission, subscribes, and saves the subscription', async () => {
    await subscribeToPush(DEVICE_ID, VAPID_KEY);

    expect(requestPermissionMock).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    const [req] = save.mock.calls[0]!;
    expect(req.deviceId).toBe(DEVICE_ID);
    expect(req.subscription.endpoint).toBe('https://push.example.com/sub-1');
    expect(req.subscription.p256dh).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(req.subscription.auth).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('throws if PushManager is not available', async () => {
    vi.unstubAllGlobals();
    await expect(subscribeToPush(DEVICE_ID, VAPID_KEY)).rejects.toThrow(/not supported/);
  });

  it('throws if notification permission is denied', async () => {
    requestPermissionMock.mockResolvedValue('denied');
    await expect(subscribeToPush(DEVICE_ID, VAPID_KEY)).rejects.toThrow(/denied/);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not expose any private key — only endpoint and transport keys reach the server', async () => {
    await subscribeToPush(DEVICE_ID, VAPID_KEY);
    const [req] = save.mock.calls[0]!;
    expect(JSON.stringify(req)).not.toContain('private');
    expect(JSON.stringify(req)).not.toContain(VAPID_KEY);
  });
});

describe('unsubscribeFromPush', () => {
  it('unsubscribes the browser subscription and deletes the server record for the given device', async () => {
    const unsub = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    setupServiceWorker(makeSubObject(unsub));

    await unsubscribeFromPush(DEVICE_ID);

    expect(unsub).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('still deletes the server record even when no browser subscription exists', async () => {
    setupServiceWorker(null);
    await unsubscribeFromPush(DEVICE_ID);
    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith(DEVICE_ID);
  });
});
