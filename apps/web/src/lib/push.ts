import { deletePushSubscription, savePushSubscription } from './api';

/** Convert an ArrayBuffer to a base64url string (no padding). Loop-safe for any buffer size. */
function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Subscribe the current device to VAPID push notifications and register the subscription with the
 * server. Caller MUST invoke this from a user-gesture handler (required by iOS and good UX everywhere).
 *
 * Throws if:
 * - The browser doesn't support push (`typeof PushManager === 'undefined'`)
 * - The user denies the Notification permission
 * - The server call fails
 */
export async function subscribeToPush(deviceId: string, vapidPublicKey: string): Promise<void> {
  if (typeof PushManager === 'undefined') {
    throw new Error('Push notifications are not supported in this browser.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Push notification permission denied.');

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey,
  });

  const rawP256dh = sub.getKey('p256dh');
  const rawAuth = sub.getKey('auth');
  if (!rawP256dh || !rawAuth) throw new Error('Push subscription missing required key material.');

  await savePushSubscription({
    deviceId,
    subscription: {
      endpoint: sub.endpoint,
      p256dh: toBase64Url(rawP256dh),
      auth: toBase64Url(rawAuth),
    },
  });
}

/**
 * Unsubscribe the current device from push notifications and remove the server-side record.
 * Scoped to the specific device — other devices' subscriptions are unaffected.
 * Silent no-op if no subscription exists.
 */
export async function unsubscribeFromPush(deviceId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await deletePushSubscription(deviceId);
}
