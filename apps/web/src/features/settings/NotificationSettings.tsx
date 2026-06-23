import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { SettingsRow, StateBlock } from '../ui';
import { subscribeToPush, unsubscribeFromPush } from '../../lib/push';

interface NotificationSettingsProps {
  deviceId: string | null;
}

const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const pushSupported = typeof window !== 'undefined' && 'PushManager' in window;

function currentPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function NotificationSettings({ deviceId }: NotificationSettingsProps) {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    currentPermission,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPermission(currentPermission());
  }, []);

  const handleEnable = useCallback(async () => {
    if (!deviceId || !VAPID_KEY) return;
    setBusy(true);
    setError(null);
    try {
      await subscribeToPush(deviceId, VAPID_KEY);
      setPermission(currentPermission());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }, [deviceId]);

  const handleDisable = useCallback(async () => {
    if (!deviceId) return;
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush(deviceId);
      setPermission(currentPermission());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable notifications.');
    } finally {
      setBusy(false);
    }
  }, [deviceId]);

  return (
    <div className="space-y-3">
      <SettingsRow
        title="Push notifications"
        value="Content-free pings only — zero message text reaches the server"
        badge="E2EE"
      />

      {permission === 'unsupported' && (
        <StateBlock icon={Bell} title="Push not supported">
          Your browser does not support push notifications.
          {typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent) && (
            <span className="block mt-1 text-white/50">
              On iOS, install argus to your Home Screen to enable notifications.
            </span>
          )}
        </StateBlock>
      )}

      {permission !== 'unsupported' && (
        <div className="space-y-2">
          {permission !== 'granted' ? (
            <SettingsRow
              title="Notifications"
              value={
                busy
                  ? 'Enabling…'
                  : !VAPID_KEY
                    ? 'Push is not configured on this server'
                    : 'Tap to enable'
              }
              enabled={false}
              disabled={busy || !deviceId || !VAPID_KEY}
              onClick={handleEnable}
            />
          ) : (
            <SettingsRow
              title="Notifications"
              value={busy ? 'Disabling…' : 'Enabled'}
              enabled={true}
              disabled={busy}
              onClick={handleDisable}
            />
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}

      <SettingsRow title="Mentions only" value="Uses the product default" badge="Default" />
      <SettingsRow title="Quiet hours" value="Uses the product default" badge="Default" />
      <StateBlock icon={Bell} title="Conversation mute controls">
        Menu item is in place. We can wire the backend setting in the next pass.
      </StateBlock>
    </div>
  );
}
