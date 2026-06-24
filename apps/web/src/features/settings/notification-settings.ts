// Persistence for notification toggles (mentions only / quiet hours). Mirrors privacy-settings.ts:
// one reader of `argus:v1:settings:notifications` so the service worker cache sync and the UI always
// agree. Pure (no React) so it is unit-testable in the node test env.

import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
} from '../../lib/persistence';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettingsRecord,
} from './NotificationSettings';

export const NOTIFICATION_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'notifications');

function decodeNotificationSettingsRecord(value: unknown): NotificationSettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  return {
    mentionsOnly:
      typeof record.mentionsOnly === 'boolean'
        ? record.mentionsOnly
        : DEFAULT_NOTIFICATION_SETTINGS.mentionsOnly,
    quietHoursEnabled:
      typeof record.quietHoursEnabled === 'boolean'
        ? record.quietHoursEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.quietHoursEnabled,
    quietHoursStart:
      typeof record.quietHoursStart === 'string' && /^\d{2}:\d{2}$/.test(record.quietHoursStart)
        ? record.quietHoursStart
        : DEFAULT_NOTIFICATION_SETTINGS.quietHoursStart,
    quietHoursEnd:
      typeof record.quietHoursEnd === 'string' && /^\d{2}:\d{2}$/.test(record.quietHoursEnd)
        ? record.quietHoursEnd
        : DEFAULT_NOTIFICATION_SETTINGS.quietHoursEnd,
  };
}

export function readStoredNotificationSettings(): NotificationSettingsRecord {
  if (typeof window === 'undefined') return DEFAULT_NOTIFICATION_SETTINGS;

  const stored = readVersionedRecord({
    storage: browserLocalStorage(),
    key: NOTIFICATION_SETTINGS_STORAGE_KEY,
    decode: decodeNotificationSettingsRecord,
  });

  return stored.status === 'ok' ? stored.value : DEFAULT_NOTIFICATION_SETTINGS;
}

export function writeStoredNotificationSettings(settings: NotificationSettingsRecord): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: NOTIFICATION_SETTINGS_STORAGE_KEY,
    value: settings,
  });
}

/**
 * Write settings to the Cache API so the service worker can read them in the push handler.
 * localStorage is not available in SW context; the Cache API is shared.
 */
export async function syncNotificationSettingsToCache(
  settings: NotificationSettingsRecord,
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open('argus-settings');
    await cache.put(
      '/notification-settings',
      new Response(JSON.stringify(settings), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  } catch {
    // Cache API unavailable; quiet hours enforcement degrades gracefully (pushes always show).
  }
}
