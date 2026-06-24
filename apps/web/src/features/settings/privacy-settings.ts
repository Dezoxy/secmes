// Persistence for the privacy toggles (read receipts / typing indicators / link previews). Extracted from
// SettingsPanel so there is ONE reader of the `argus:settings:privacy` key — the chat message loop needs
// `isReadReceiptsEnabled()` to gate read-receipt sends + the reciprocal display cap, and it must agree with
// what the settings UI writes. Pure (no React) so it's unit-testable in the node test env.

import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
} from '../../lib/persistence';
import { DEFAULT_PRIVACY_SETTINGS, type PrivacySettingsRecord } from './PrivacySettings';
import type { PrivacySettings } from '../../lib/api';

export const PRIVACY_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'privacy');

function decodePrivacySettingsRecord(value: unknown): PrivacySettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  return {
    readReceipts:
      typeof record.readReceipts === 'boolean'
        ? record.readReceipts
        : DEFAULT_PRIVACY_SETTINGS.readReceipts,
    typingIndicators:
      typeof record.typingIndicators === 'boolean'
        ? record.typingIndicators
        : DEFAULT_PRIVACY_SETTINGS.typingIndicators,
    linkPreviews:
      typeof record.linkPreviews === 'boolean'
        ? record.linkPreviews
        : DEFAULT_PRIVACY_SETTINGS.linkPreviews,
  };
}

export function readStoredPrivacySettings(): PrivacySettingsRecord {
  if (typeof window === 'undefined') return DEFAULT_PRIVACY_SETTINGS;

  const stored = readVersionedRecord({
    storage: browserLocalStorage(),
    key: PRIVACY_SETTINGS_STORAGE_KEY,
    decode: decodePrivacySettingsRecord,
  });

  return stored.status === 'ok' ? stored.value : DEFAULT_PRIVACY_SETTINGS;
}

export function writeStoredPrivacySettings(settings: PrivacySettingsRecord): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: PRIVACY_SETTINGS_STORAGE_KEY,
    value: settings,
  });
}

/**
 * Write server-fetched settings into localStorage so the local cache agrees with the server.
 * Call once after a successful `fetchPrivacySettings()` response.
 */
export function syncFromServer(serverSettings: PrivacySettings): void {
  writeStoredPrivacySettings({
    readReceipts: serverSettings.readReceipts,
    typingIndicators: serverSettings.typingIndicators,
    linkPreviews: serverSettings.linkPreviews,
  });
}

/**
 * Whether to SEND read receipts and RENDER peers' read ticks. Reciprocal privacy: when off, the client both
 * stops POSTing `read` watermarks and caps a peer's tick at `delivered` (see foldOwnMessageStatuses). Reads
 * live from storage each call so a toggle in settings takes effect on the next message event without a reload.
 */
export function isReadReceiptsEnabled(): boolean {
  return readStoredPrivacySettings().readReceipts;
}
