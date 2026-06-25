import { deletePushSubscription, savePushSubscription } from './api';

// Records whether the user EXPLICITLY turned push off. Notification permission stays 'granted' after a
// disable (browsers don't let JS revoke it), so permission alone can't tell "iOS dropped the subscription
// on update" (restore it) apart from "the user tapped Disable" (leave it off). This flag carries that intent
// across reloads so the silent reconcile never re-enables push the user deliberately disabled.
const PUSH_USER_DISABLED_KEY = 'argus-push-user-disabled';

function setPushUserDisabled(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(PUSH_USER_DISABLED_KEY, '1');
    else localStorage.removeItem(PUSH_USER_DISABLED_KEY);
  } catch {
    // localStorage unavailable (e.g. private mode) — best-effort intent tracking only.
  }
}

function pushUserDisabled(): boolean {
  try {
    return localStorage.getItem(PUSH_USER_DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Convert an ArrayBuffer to a base64url string (no padding). Loop-safe for any buffer size. */
function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string (VAPID public key) to its raw bytes. Inverse of toBase64Url. */
function fromBase64Url(b64url: string): Uint8Array {
  // Normalise to base64 and strip any existing padding before re-padding, so padded or unpadded input both work.
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Whether an existing subscription's applicationServerKey matches the current VAPID public key. A mismatch
 * means the server's VAPID identity rotated since this subscription was created — the old subscription can
 * no longer receive our pushes and must be replaced.
 */
function applicationServerKeyMatches(
  existing: ArrayBuffer | null,
  vapidPublicKey: string,
): boolean {
  if (!existing) return false;
  const have = new Uint8Array(existing);
  const want = fromBase64Url(vapidPublicKey);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i += 1) {
    if (have[i] !== want[i]) return false;
  }
  return true;
}

/** Extract the RFC 8291 transport keys from a subscription and register it with the server. */
async function saveSubscription(deviceId: string, sub: PushSubscription): Promise<void> {
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

/** Subscribe via the active service-worker registration and persist the subscription to the server. */
async function subscribeAndSave(
  reg: ServiceWorkerRegistration,
  deviceId: string,
  vapidPublicKey: string,
): Promise<void> {
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey,
  });
  await saveSubscription(deviceId, sub);
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
  await subscribeAndSave(reg, deviceId, vapidPublicKey);
  setPushUserDisabled(false); // an explicit enable clears any prior "user disabled" intent
}

/**
 * Silently restore the device's push subscription if it has gone missing or stale — WITHOUT ever prompting
 * for permission. Call on every authenticated startup so push survives app updates with no user action.
 *
 * A Web Push subscription is bound to the service worker, and some platforms (notably iOS home-screen PWAs)
 * drop it when the SW is replaced on update — leaving the toggle stuck on "Tap to enable" until the user
 * re-enables by hand. This re-creates a dropped subscription, replaces one made under a rotated VAPID key,
 * and otherwise re-persists the existing one (idempotent) so a server row pruned on a 410/404 self-heals.
 *
 * No-op (never throws on the happy path) when push is unsupported or permission isn't already granted.
 */
export async function reconcilePushSubscription(
  deviceId: string,
  vapidPublicKey: string,
): Promise<void> {
  if (typeof PushManager === 'undefined') return;
  // Permission stays 'granted' across updates (browsers don't auto-revoke it); only the subscription is lost.
  // If the user never granted it (or revoked it), do nothing — re-enabling stays an explicit, gesture-driven act.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // The user explicitly turned push off (permission is still 'granted' but the subscription was removed on
  // purpose) — honour that intent rather than silently re-enabling it.
  if (pushUserDisabled()) return;

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  // Missing (e.g. iOS dropped it on update) or created under a now-rotated VAPID key → (re)create from scratch.
  if (
    !existing ||
    !applicationServerKeyMatches(existing.options.applicationServerKey, vapidPublicKey)
  ) {
    if (existing) await existing.unsubscribe();
    await subscribeAndSave(reg, deviceId, vapidPublicKey);
    return;
  }

  // Present and current — re-persist idempotently so a server-side row pruned on 410/404 is restored.
  await saveSubscription(deviceId, existing);
}

/**
 * Unsubscribe the current device from push notifications and remove the server-side record.
 * Scoped to the specific device — other devices' subscriptions are unaffected.
 * Silent no-op if no subscription exists.
 */
export async function unsubscribeFromPush(deviceId: string): Promise<void> {
  setPushUserDisabled(true); // record intent first so a concurrent reconcile can't race a re-enable
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await deletePushSubscription(deviceId);
}
