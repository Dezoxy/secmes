import { afterEach, describe, expect, it, vi } from 'vitest';
import { showPwaUpdateNotification } from './pwa-update-notification';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('showPwaUpdateNotification', () => {
  it('shows a service-worker notification when permission is already granted', async () => {
    const showNotification = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal('Notification', { permission: 'granted' });

    await expect(
      showPwaUpdateNotification(
        { showNotification } as unknown as ServiceWorkerRegistration,
        'v0.8.24',
      ),
    ).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledWith(
      'Argus update available',
      expect.objectContaining({
        body: 'Version v0.8.24 is ready to install.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'argus-update-available',
        renotify: false,
      }),
    );
  });

  it('does not prompt or notify when permission is not granted', async () => {
    const showNotification = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal('Notification', { permission: 'default' });

    await expect(
      showPwaUpdateNotification(
        { showNotification } as unknown as ServiceWorkerRegistration,
        'v0.8.24',
      ),
    ).resolves.toBe(false);

    expect(showNotification).not.toHaveBeenCalled();
  });

  it('uses navigator.serviceWorker.ready when no registration is supplied', async () => {
    const showNotification = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({ showNotification }),
      },
    });

    await expect(showPwaUpdateNotification(null, null)).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledWith(
      'Argus update available',
      expect.objectContaining({
        body: 'A new version is ready.',
        tag: 'argus-update-available',
      }),
    );
  });
});
