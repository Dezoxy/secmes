// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { savePrivacySettings } from '../../lib/api';
import { SettingsPanel } from './SettingsPanel';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    fetchPrivacySettings: vi.fn(() => new Promise(() => {})),
    savePrivacySettings: vi.fn().mockResolvedValue(undefined),
  };
});

function clickButton(text: string): void {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('SettingsPanel privacy persistence', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(savePrivacySettings).mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flushes a pending privacy save when unmounted before the debounce fires', () => {
    act(() => {
      root.render(
        createElement(SettingsPanel, {
          profile: { id: 'profile-1', username: 'Alex', avatar: '' },
          deviceId: null,
          serverHandle: null,
          serverProfile: null,
          onProfileChange: () => true,
          standalone: true,
        }),
      );
    });

    act(() => {
      clickButton('Privacy');
    });
    act(() => {
      clickButton('Read receipts');
    });

    expect(savePrivacySettings).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(savePrivacySettings).toHaveBeenCalledWith({
      readReceipts: false,
    });
  });
});
