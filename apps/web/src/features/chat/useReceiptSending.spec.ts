// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordReceipt } from '../../lib/api';
import { DEFAULT_PRIVACY_SETTINGS } from '../settings/PrivacySettings';
import { writeStoredPrivacySettings } from '../settings/privacy-settings';
import { useReceiptSending } from './useReceiptSending';
import type { Conversation } from './seed';

vi.mock('../../lib/api', () => ({
  recordReceipt: vi.fn().mockResolvedValue(undefined),
}));

const conversation: Conversation = {
  id: 'live-1',
  type: 'direct',
  participants: [],
  unreadCount: 0,
  messages: [
    {
      id: 'peer-message-1',
      senderId: 'peer-user',
      content: 'hello',
      timestamp: new Date(0),
      status: 'sent',
    },
  ],
};

function ReceiptHarness({ privacySettingsVersion }: { privacySettingsVersion: number }) {
  useReceiptSending({
    conversations: [conversation],
    liveIds: new Set([conversation.id]),
    selectedId: conversation.id,
    selectedIsLive: true,
    privacySettingsVersion,
  });
  return null;
}

describe('useReceiptSending', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    window.localStorage.clear();
    vi.mocked(recordReceipt).mockClear();
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('re-checks read receipts after privacy settings hydrate', async () => {
    await act(async () => {
      root.render(createElement(ReceiptHarness, { privacySettingsVersion: 0 }));
    });

    expect(recordReceipt).toHaveBeenCalledWith(conversation.id, 'delivered', 'peer-message-1');
    expect(vi.mocked(recordReceipt).mock.calls.some(([, kind]) => kind === 'read')).toBe(false);

    writeStoredPrivacySettings({ ...DEFAULT_PRIVACY_SETTINGS, readReceipts: true });

    await act(async () => {
      root.render(createElement(ReceiptHarness, { privacySettingsVersion: 1 }));
    });

    expect(recordReceipt).toHaveBeenCalledWith(conversation.id, 'read', 'peer-message-1');
  });
});
