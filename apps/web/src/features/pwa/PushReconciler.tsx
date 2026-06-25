import { useEffect } from 'react';

import { reconcilePushSubscription } from '../../lib/push';
import { useDevice } from '../device/DeviceContext';

const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

/**
 * Background self-heal for Web Push. Whenever the authenticated device is ready, silently restore a push
 * subscription that was dropped — without prompting — so push survives app updates with no user action.
 *
 * A subscription is bound to the service worker and some platforms (notably iOS home-screen PWAs) drop it
 * when the SW is replaced on update, leaving the Settings toggle stuck on "Tap to enable". This runs
 * `reconcilePushSubscription` (a no-op unless permission was already granted) on mount and again whenever the
 * SW reports a browser-initiated `pushsubscriptionchange`. Renders nothing.
 */
export function PushReconciler(): null {
  const { deviceId } = useDevice();

  useEffect(() => {
    if (!deviceId || !VAPID_KEY) return;
    const vapidKey = VAPID_KEY;

    const reconcile = () => {
      reconcilePushSubscription(deviceId, vapidKey).catch(() => {
        // best-effort background heal — the Settings toggle remains the explicit fallback
      });
    };

    reconcile();

    const sw = navigator.serviceWorker;
    if (!sw) return;
    // The SW posts this after a browser-initiated pushsubscriptionchange so we re-register the new endpoint.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'push-subscription-changed') reconcile();
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [deviceId]);

  return null;
}
