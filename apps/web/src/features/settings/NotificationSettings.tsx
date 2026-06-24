import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { SettingsRow, StateBlock } from '../ui';
import { subscribeToPush, unsubscribeFromPush } from '../../lib/push';
import { readMutedConversationIds, syncMuteStateToCache, unmuteAll } from './conversation-mute';

export type NotificationSettingsRecord = {
  quietHoursEnabled: boolean;
  quietHoursStart: string; // "HH:MM" 24-hour
  quietHoursEnd: string;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsRecord = {
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
};

interface NotificationSettingsProps {
  deviceId: string | null;
  settings: NotificationSettingsRecord;
  onSettingsChange: (settings: NotificationSettingsRecord) => void;
}

const VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const pushSupported = typeof window !== 'undefined' && 'PushManager' in window;

function currentPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function NotificationSettings({
  deviceId,
  settings,
  onSettingsChange,
}: NotificationSettingsProps) {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    currentPermission,
  );
  // Tracks actual PushManager subscription, not just browser permission.
  // Permission stays 'granted' after unsubscribe (browsers don't allow JS to revoke it),
  // so we check the real subscription on mount and update it on enable/disable.
  const [subscribed, setSubscribed] = useState<boolean>(
    // Best-guess initial: assume subscribed if permission is already granted.
    // The effect below corrects this to the real subscription state.
    () => currentPermission() === 'granted',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutedCount, setMutedCount] = useState(() => readMutedConversationIds().size);

  useEffect(() => {
    const perm = currentPermission();
    setPermission(perm);
    if (perm !== 'granted') {
      setSubscribed(false);
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(sub !== null))
      .catch(() => setSubscribed(false));
  }, []);

  const handleEnable = useCallback(async () => {
    if (!deviceId || !VAPID_KEY) return;
    setBusy(true);
    setError(null);
    try {
      await subscribeToPush(deviceId, VAPID_KEY);
      setPermission(currentPermission());
      setSubscribed(true);
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
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable notifications.');
    } finally {
      setBusy(false);
    }
  }, [deviceId]);

  const handleUnmuteAll = useCallback(() => {
    unmuteAll();
    void syncMuteStateToCache(new Set());
    setMutedCount(0);
  }, []);

  const toggleQuietHours = () => {
    onSettingsChange({ ...settings, quietHoursEnabled: !settings.quietHoursEnabled });
  };

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
          {subscribed ? (
            <SettingsRow
              title="Notifications"
              value={busy ? 'Disabling…' : 'Enabled'}
              enabled={true}
              disabled={busy}
              onClick={handleDisable}
            />
          ) : (
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
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}

      <SettingsRow
        title="Quiet hours"
        value={
          settings.quietHoursEnabled
            ? `${settings.quietHoursStart} – ${settings.quietHoursEnd}`
            : 'Off – notifications always allowed'
        }
        enabled={settings.quietHoursEnabled}
        onClick={toggleQuietHours}
      />

      {settings.quietHoursEnabled && (
        <div className="flex gap-6 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <label className="flex items-center gap-2 text-xs text-white/60">
            From
            <input
              type="time"
              value={settings.quietHoursStart}
              onChange={(e) => onSettingsChange({ ...settings, quietHoursStart: e.target.value })}
              className="bg-transparent text-sm text-white focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-white/60">
            To
            <input
              type="time"
              value={settings.quietHoursEnd}
              onChange={(e) => onSettingsChange({ ...settings, quietHoursEnd: e.target.value })}
              className="bg-transparent text-sm text-white focus:outline-none"
            />
          </label>
        </div>
      )}

      {mutedCount > 0 ? (
        <SettingsRow
          title="Conversation mute controls"
          value={`${mutedCount} conversation${mutedCount === 1 ? '' : 's'} muted — tap to unmute all`}
          onClick={handleUnmuteAll}
        />
      ) : (
        <SettingsRow
          title="Conversation mute controls"
          value="Mute individual conversations from their long-press menu"
          badge="0 muted"
        />
      )}
    </div>
  );
}
