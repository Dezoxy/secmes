// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_PRIVACY_SETTINGS } from './PrivacySettings';
import {
  isReadReceiptsEnabled,
  readPrivacySettingsRevision,
  readStoredPrivacySettings,
  writeStoredPrivacySettings,
} from './privacy-settings';

describe('privacy-settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults read receipts to off (safe default) when nothing is cached', () => {
    // Privacy-safe: no receipts until syncFromServer() confirms the user's preference.
    expect(isReadReceiptsEnabled()).toBe(false);
  });

  it('round-trips the stored privacy record and reflects a disabled read-receipt toggle', () => {
    writeStoredPrivacySettings({
      readReceipts: false,
      typingIndicators: true,
      linkPreviews: false,
    });
    expect(isReadReceiptsEnabled()).toBe(false);
    expect(readStoredPrivacySettings()).toEqual({
      readReceipts: false,
      typingIndicators: true,
      linkPreviews: false,
    });
  });

  it('reads live (a later write changes the answer without a reload)', () => {
    writeStoredPrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, readReceipts: false });
    expect(isReadReceiptsEnabled()).toBe(false);
    writeStoredPrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, readReceipts: true });
    expect(isReadReceiptsEnabled()).toBe(true);
  });

  it('increments the in-runtime revision when the shared cache changes', () => {
    const before = readPrivacySettingsRevision();

    writeStoredPrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, readReceipts: false });

    expect(readPrivacySettingsRevision()).toBeGreaterThan(before);
  });
});
