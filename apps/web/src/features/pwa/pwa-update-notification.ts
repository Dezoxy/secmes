const UPDATE_NOTIFICATION_TAG = 'argus-update-available';

export async function showPwaUpdateNotification(
  registration: ServiceWorkerRegistration | null,
  version: string | null,
): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  const title = 'Argus update available';
  const body = version ? `Version ${version} is ready to install.` : 'A new version is ready.';
  const options: NotificationOptions & { renotify: boolean } = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: UPDATE_NOTIFICATION_TAG,
    renotify: false,
    data: { url: '/' },
  };

  try {
    const readyRegistration =
      registration ??
      (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? await navigator.serviceWorker.ready
        : null);
    if (readyRegistration) {
      await readyRegistration.showNotification(title, options);
      return true;
    }

    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
