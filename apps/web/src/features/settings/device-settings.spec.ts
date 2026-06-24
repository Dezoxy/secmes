// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ACCENT_STORAGE_KEY } from '../../lib/persistence';
import { readStoredDeviceSettings } from './device-settings';

describe('device settings persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('falls back to defaults when legacy setting reads are blocked', () => {
    const storagePrototype = Object.getPrototypeOf(window.localStorage) as Storage;
    vi.spyOn(storagePrototype, 'getItem').mockImplementation((key: string) => {
      if (key === LEGACY_ACCENT_STORAGE_KEY) {
        throw new DOMException('blocked', 'SecurityError');
      }
      return null;
    });

    expect(readStoredDeviceSettings()).toEqual({ accentId: 'purple', fontSizeLevel: 5 });
  });
});
