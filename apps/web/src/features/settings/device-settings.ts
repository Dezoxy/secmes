// Persistence for device-local appearance settings (accent colour + font size). Extracted from
// SettingsPanel so main.tsx can read the stored values at boot — before React renders — to avoid
// a flash of the default theme before the user's preference is applied.

import {
  browserLocalStorage,
  LEGACY_ACCENT_STORAGE_KEY,
  LEGACY_FONT_SIZE_STORAGE_KEY,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
} from '../../lib/persistence';
import { defaultAccentId, isAccentId, type AccentId } from '../ui';
import { FONT_SIZE_LEVELS } from './AppearanceSettings';

export const DEVICE_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'device');

export interface DeviceSettingsRecord {
  accentId: AccentId;
  fontSizeLevel: number;
}

function decodeDeviceSettingsRecord(value: unknown): DeviceSettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const accentId = typeof record.accentId === 'string' ? record.accentId : defaultAccentId;
  const fontSizeLevel = typeof record.fontSizeLevel === 'number' ? record.fontSizeLevel : 5;

  return {
    accentId: isAccentId(accentId) ? accentId : defaultAccentId,
    fontSizeLevel: FONT_SIZE_LEVELS.includes(fontSizeLevel) ? fontSizeLevel : 5,
  };
}

export function readStoredDeviceSettings(): DeviceSettingsRecord {
  if (typeof window === 'undefined') {
    return { accentId: defaultAccentId, fontSizeLevel: 5 };
  }

  const storage = browserLocalStorage();
  const stored = readVersionedRecord({
    storage,
    key: DEVICE_SETTINGS_STORAGE_KEY,
    decode: decodeDeviceSettingsRecord,
  });
  if (stored.status === 'ok') return stored.value;

  const legacyAccent = storage.getItem(LEGACY_ACCENT_STORAGE_KEY);
  const legacyFontSize = Number.parseInt(storage.getItem(LEGACY_FONT_SIZE_STORAGE_KEY) ?? '', 10);
  const migrated = {
    accentId: isAccentId(legacyAccent) ? legacyAccent : defaultAccentId,
    fontSizeLevel: FONT_SIZE_LEVELS.includes(legacyFontSize) ? legacyFontSize : 5,
  };

  writeVersionedRecord({ storage, key: DEVICE_SETTINGS_STORAGE_KEY, value: migrated });
  return migrated;
}

export function writeStoredDeviceSettings(settings: DeviceSettingsRecord): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: DEVICE_SETTINGS_STORAGE_KEY,
    value: settings,
  });
}
