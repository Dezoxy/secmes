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
    fontSizeLevel:
      Number.isInteger(fontSizeLevel) && fontSizeLevel >= 1 && fontSizeLevel <= 10
        ? fontSizeLevel
        : 5,
  };
}

const DEFAULTS: DeviceSettingsRecord = { accentId: defaultAccentId, fontSizeLevel: 5 };

export function readStoredDeviceSettings(): DeviceSettingsRecord {
  if (typeof window === 'undefined') return DEFAULTS;

  let storage: ReturnType<typeof browserLocalStorage>;
  try {
    storage = browserLocalStorage();
  } catch {
    // Safari throws SecurityError when storage is blocked (private mode / ITP).
    return DEFAULTS;
  }

  const stored = readVersionedRecord({
    storage,
    key: DEVICE_SETTINGS_STORAGE_KEY,
    decode: decodeDeviceSettingsRecord,
  });
  if (stored.status === 'ok') return stored.value;
  if (stored.status === 'unavailable') return DEFAULTS;

  let legacyAccent: string | null;
  let legacyFontSizeRaw: string | null;
  try {
    legacyAccent = storage.getItem(LEGACY_ACCENT_STORAGE_KEY);
    legacyFontSizeRaw = storage.getItem(LEGACY_FONT_SIZE_STORAGE_KEY);
  } catch {
    return DEFAULTS;
  }

  const legacyFontSize = Number.parseInt(legacyFontSizeRaw ?? '', 10);
  const migrated = {
    accentId: isAccentId(legacyAccent) ? legacyAccent : defaultAccentId,
    fontSizeLevel:
      Number.isInteger(legacyFontSize) && legacyFontSize >= 1 && legacyFontSize <= 10
        ? legacyFontSize
        : 5,
  };

  writeVersionedRecord({ storage, key: DEVICE_SETTINGS_STORAGE_KEY, value: migrated });
  return migrated;
}

export function writeStoredDeviceSettings(settings: DeviceSettingsRecord): void {
  if (typeof window === 'undefined') return;
  try {
    writeVersionedRecord({
      storage: browserLocalStorage(),
      key: DEVICE_SETTINGS_STORAGE_KEY,
      value: settings,
    });
  } catch {
    // Storage unavailable; settings won't persist but the app remains functional.
  }
}
