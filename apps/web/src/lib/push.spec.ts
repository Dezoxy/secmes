import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}));

import { savePushSubscription, deletePushSubscription } from './api';
import {
  pushNeedsReenable,
  reconcilePushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from './push';

const save = vi.mocked(savePushSubscription);
const del = vi.mocked(deletePushSubscription);

const VAPID_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DEVICE_ID = '00000000-0000-0000-0000-000000000001';

const requestPermissionMock = vi.fn<() => Promise<NotificationPermission>>();

/** Decode a base64url/base64 VAPID key to the ArrayBuffer the browser exposes as applicationServerKey. */
function keyBytes(b64: string): ArrayBuffer {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function makeSubObject(unsubscribeFn = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)) {
  return {
    endpoint: 'https://push.example.com/sub-1',
    options: { applicationServerKey: keyBytes(VAPID_KEY) },
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

/** Service worker whose existing subscription and freshly-minted subscription can differ (reconcile cases). */
function setupReconcileWorker(
  existing: ReturnType<typeof makeSubObject> | null,
  fresh: ReturnType<typeof makeSubObject> = makeSubObject(),
) {
  const subscribe = vi.fn().mockResolvedValue(fresh);
  const getSubscription = vi.fn().mockResolvedValue(existing);
  const ready = Promise.resolve({ pushManager: { subscribe, getSubscription } });
  vi.stubGlobal('navigator', { serviceWorker: { ready } });
  return { subscribe, getSubscription };
}

/** In-memory localStorage stub — this spec runs in the node env where localStorage is absent. */
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubLocalStorage(); // fresh "user disabled push" intent flag store between tests
  save.mockResolvedValue(undefined);
  del.mockResolvedValue(undefined);
  requestPermissionMock.mockResolvedValue('granted');
  vi.stubGlobal('PushManager', class PushManager {});
  vi.stubGlobal('Notification', {
    permission: 'granted',
    requestPermission: requestPermissionMock,
  });
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

describe('reconcilePushSubscription', () => {
  it('is a no-op when permission has not been granted (never prompts)', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: requestPermissionMock,
    });
    const { subscribe, getSubscription } = setupReconcileWorker(null);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('subscribes and saves when no subscription exists (the dropped-on-update case)', async () => {
    const { subscribe } = setupReconcileWorker(null);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].deviceId).toBe(DEVICE_ID);
    expect(requestPermissionMock).not.toHaveBeenCalled();
  });

  it('re-saves the existing subscription idempotently when the VAPID key still matches', async () => {
    const existing = makeSubObject();
    const { subscribe } = setupReconcileWorker(existing);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].subscription.endpoint).toBe('https://push.example.com/sub-1');
  });

  it('replaces the subscription when the VAPID key has rotated', async () => {
    const stale = makeSubObject();
    stale.options = { applicationServerKey: new Uint8Array([9, 9, 9]).buffer };
    const { subscribe } = setupReconcileWorker(stale);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it('is a no-op when push is unsupported', async () => {
    vi.unstubAllGlobals();
    await expect(reconcilePushSubscription(DEVICE_ID, VAPID_KEY)).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('does NOT re-enable push the user explicitly disabled (permission granted, subscription gone)', async () => {
    // Simulate an explicit disable: unsubscribeFromPush records intent even though permission stays granted.
    await unsubscribeFromPush(DEVICE_ID);
    vi.clearAllMocks();
    const { subscribe } = setupReconcileWorker(null);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(subscribe).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('resumes self-healing after the user re-enables push (intent flag cleared)', async () => {
    await unsubscribeFromPush(DEVICE_ID); // sets the disabled flag
    await subscribeToPush(DEVICE_ID, VAPID_KEY); // an explicit enable clears it
    vi.clearAllMocks();
    const { subscribe } = setupReconcileWorker(null);

    await reconcilePushSubscription(DEVICE_ID, VAPID_KEY);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
});

describe('pushNeedsReenable', () => {
  it('is true when push should be on but the subscription is gone (the iOS dropped-on-update case)', async () => {
    setupReconcileWorker(null); // permission granted (beforeEach), no subscription, not user-disabled
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(true);
  });

  it('is true when a stale subscription remains under a now-rotated VAPID key', async () => {
    const stale = makeSubObject();
    stale.options = { applicationServerKey: new Uint8Array([9, 9, 9]).buffer };
    setupReconcileWorker(stale);
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(true);
  });

  it('is false when an active subscription already exists under the current key', async () => {
    setupReconcileWorker(makeSubObject());
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(false);
  });

  it('is false when the user explicitly disabled push', async () => {
    await unsubscribeFromPush(DEVICE_ID); // sets the disabled intent flag
    setupReconcileWorker(null);
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(false);
  });

  it('is false when notification permission was never granted', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: requestPermissionMock,
    });
    setupReconcileWorker(null);
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(false);
  });

  it('is false when push is unsupported', async () => {
    vi.unstubAllGlobals();
    await expect(pushNeedsReenable(VAPID_KEY)).resolves.toBe(false);
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
