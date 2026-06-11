import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { Button, SettingsRow, StateBlock } from '../ui';
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
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                onClick={handleEnable}
                disabled={busy || !deviceId || !VAPID_KEY}
                aria-busy={busy}
              >
                <Bell className="h-4 w-4 mr-1.5" />
                {busy ? 'Enabling…' : 'Enable notifications'}
              </Button>
              {!VAPID_KEY && (
                <span className="text-xs text-white/60">
                  Push is not configured on this server.
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <SettingsRow title="Notifications" value="Enabled" badge="On" />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDisable}
                disabled={busy}
                aria-busy={busy}
              >
                <BellOff className="h-4 w-4 mr-1.5" />
                {busy ? 'Disabling…' : 'Disable'}
              </Button>
            </div>
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
