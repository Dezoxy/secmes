import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';

import { pushNeedsReenable, reconcilePushSubscription, subscribeToPush } from '../../lib/push';
import { Button, useToast } from '../ui';
import { useDevice } from '../device/DeviceContext';

const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

/**
 * Keeps Web Push working across app updates. Whenever the authenticated device is ready it first tries
 * the SILENT self-heal (`reconcilePushSubscription`), which restores a dropped subscription with no user
 * action on Android/desktop.
 *
 * On iOS the service worker's `pushsubscriptionchange` handler re-subscribes in SW context (no user
 * gesture required per spec), so the silent path now also works on iOS after an SW update. The banner
 * is retained as a fallback: if the SW-level subscribe still fails (e.g. iOS <16.4, offline, push
 * provider error) and `pushNeedsReenable()` returns true, a one-tap restore prompt is shown.
 */
export function PushReconciler() {
  const { deviceId } = useDevice();
  const { toast } = useToast();
  const [needsReenable, setNeedsReenable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards the gesture-driven restore path: if the shell unmounts (e.g. logout) while subscribeToPush is
  // in flight, its continuations must not touch state or fire a stale "restored" toast on the dead instance.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!deviceId || !VAPID_KEY) return;
    const vapidKey = VAPID_KEY;
    let active = true;

    const reconcile = async () => {
      // Silent restore first — works on Android/desktop; on iOS it throws (no user gesture) and is swallowed.
      try {
        await reconcilePushSubscription(deviceId, vapidKey);
      } catch {
        // best-effort — fall through to decide whether a one-tap restore is needed
      }
      // Push should be on but there's still no usable subscription → offer the gesture-driven restore (iOS path).
      const needs = await pushNeedsReenable(vapidKey);
      if (active) setNeedsReenable(needs);
    };

    void reconcile();

    const sw = navigator.serviceWorker;
    if (!sw) {
      return () => {
        active = false;
      };
    }
    // The SW posts this after a browser-initiated pushsubscriptionchange (non-iOS) — re-check then too.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'push-subscription-changed') void reconcile();
    };
    sw.addEventListener('message', onMessage);
    return () => {
      active = false;
      sw.removeEventListener('message', onMessage);
    };
  }, [deviceId]);

  const handleRestore = useCallback(async () => {
    if (!deviceId || !VAPID_KEY) return;
    setBusy(true);
    setError(null);
    try {
      await subscribeToPush(deviceId, VAPID_KEY); // gesture-driven re-subscribe — the tap iOS requires
      if (!mounted.current) return;
      setNeedsReenable(false);
      toast('Notifications turned back on', { variant: 'success' });
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : 'Could not turn notifications back on.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [deviceId, toast]);

  if (!needsReenable || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-dashed border-amber-400/20 bg-amber-500/[0.08] px-4 py-3 backdrop-blur">
        <Bell className="h-4 w-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">Notifications were turned off</p>
          <p className="text-xs text-white/60">
            {error ?? 'An app update reset them. Tap to turn them back on.'}
          </p>
        </div>
        <Button size="sm" onClick={handleRestore} disabled={busy} aria-busy={busy}>
          {busy ? 'Turning on…' : 'Turn back on'}
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md p-1 text-white/40 transition-colors hover:text-white/70"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
