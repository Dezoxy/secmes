// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ConversationList } from './ConversationList';
import { conversations as seedConversations, currentUser } from './seed';
import type { Friend } from '../../lib/api';

const ALICE: Friend = {
  userId: 'a1a1a1a1-0000-4000-8000-000000000001',
  argusId: 'argus-alicealicealice-a1a',
  displayName: 'Alice',
  avatarSeed: null,
  since: new Date().toISOString(),
};

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  );
}

function findFriendsEntryButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    Array.from(b.querySelectorAll('span')).some((s) => s.textContent?.trim() === 'Friends'),
  );
}

describe('ConversationList — unfriend interactive flow', () => {
  it('Remove button triggers confirm then calls onUnfriend on Confirm click', async () => {
    const onUnfriend = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(ConversationList, {
          conversations: seedConversations.slice(0, 1),
          currentUserProfile: currentUser,
          selectedId: 'conv-1',
          onSelect: () => undefined,
          friends: [ALICE],
          onUnfriend,
        }),
      );
    });

    // Open the friends panel
    const friendsBtn = findFriendsEntryButton(container);
    expect(friendsBtn, 'Friends entry button must be in the DOM').toBeTruthy();
    await act(async () => {
      friendsBtn!.click();
    });

    // Remove button appears for the friend row
    const removeBtn = findButtonByLabel(container, 'Remove friend Alice');
    expect(
      removeBtn,
      'Remove friend button must be visible after opening friends panel',
    ).toBeTruthy();

    // Click Remove → confirm state
    await act(async () => {
      removeBtn!.click();
    });

    expect(
      findButtonByLabel(container, 'Remove friend Alice'),
      'Remove button should be gone while confirming',
    ).toBeUndefined();

    const confirmBtn = findButtonByLabel(container, 'Confirm remove Alice');
    expect(confirmBtn, 'Confirm remove button must appear').toBeTruthy();

    // Click Confirm → onUnfriend called
    await act(async () => {
      confirmBtn!.click();
    });

    expect(onUnfriend).toHaveBeenCalledOnce();
    expect(onUnfriend).toHaveBeenCalledWith(ALICE.userId);

    root.unmount();
    document.body.removeChild(container);
  });

  it('Cancel button returns the row to its initial Remove state', async () => {
    const onUnfriend = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(ConversationList, {
          conversations: seedConversations.slice(0, 1),
          currentUserProfile: currentUser,
          selectedId: 'conv-1',
          onSelect: () => undefined,
          friends: [ALICE],
          onUnfriend,
        }),
      );
    });

    const friendsBtn = findFriendsEntryButton(container);
    await act(async () => {
      friendsBtn!.click();
    });

    await act(async () => {
      findButtonByLabel(container, 'Remove friend Alice')!.click();
    });

    // Cancel returns to normal state
    const cancelBtn = findButtonByLabel(container, 'Cancel remove');
    expect(cancelBtn).toBeTruthy();
    await act(async () => {
      cancelBtn!.click();
    });

    expect(findButtonByLabel(container, 'Remove friend Alice')).toBeTruthy();
    expect(onUnfriend).not.toHaveBeenCalled();

    root.unmount();
    document.body.removeChild(container);
  });
});
