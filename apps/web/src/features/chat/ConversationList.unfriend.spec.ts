// @vitest-environment jsdom
// The unfriend interactive flow moved from ConversationList to FriendsScreen when the friends
// panel was extracted into its own tab. These tests cover the same confirm/cancel behaviour.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useChatContext } from '../chat/ChatContext';
import FriendsScreen from '../friends/FriendsScreen';
import type { Friend } from '../../lib/api';

vi.mock('../chat/ChatContext');

const ALICE: Friend = {
  userId: 'a1a1a1a1-0000-4000-8000-000000000001',
  argusId: 'argus-alicealicealice-a1a',
  displayName: 'Alice',
  avatarSeed: null,
  since: new Date().toISOString(),
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [],
    friends: [ALICE],
    friendsLoaded: true,
    incomingRequests: [],
    outgoingRequests: [],
    friendsError: false,
    manager: {} as unknown,
    refreshFriends: vi.fn().mockResolvedValue(undefined),
    handleSendFriendRequest: vi.fn(),
    handleAcceptRequest: vi.fn(),
    handleDeclineRequest: vi.fn(),
    handleCancelRequest: vi.fn(),
    handleUnfriend: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  );
}

beforeEach(() => {
  vi.mocked(useChatContext).mockReturnValue(
    makeCtx() as unknown as ReturnType<typeof useChatContext>,
  );
});

describe('FriendsScreen — unfriend interactive flow', () => {
  it('Remove button triggers confirm then calls handleUnfriend on Confirm click', async () => {
    const handleUnfriend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useChatContext).mockReturnValue(
      makeCtx({ handleUnfriend }) as unknown as ReturnType<typeof useChatContext>,
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(FriendsScreen)));
    });

    const removeBtn = findButtonByLabel(container, 'Remove friend Alice');
    expect(removeBtn, 'Remove friend button must be visible').toBeTruthy();

    await act(async () => {
      removeBtn!.click();
    });

    expect(
      findButtonByLabel(container, 'Remove friend Alice'),
      'Remove button should be gone while confirming',
    ).toBeUndefined();

    const confirmBtn = findButtonByLabel(container, 'Confirm remove Alice');
    expect(confirmBtn, 'Confirm remove button must appear').toBeTruthy();

    await act(async () => {
      confirmBtn!.click();
    });

    expect(handleUnfriend).toHaveBeenCalledOnce();
    expect(handleUnfriend).toHaveBeenCalledWith(ALICE.userId);

    root.unmount();
    document.body.removeChild(container);
  });

  it('Cancel button returns the row to its initial Remove state', async () => {
    const handleUnfriend = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useChatContext).mockReturnValue(
      makeCtx({ handleUnfriend }) as unknown as ReturnType<typeof useChatContext>,
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(FriendsScreen)));
    });

    await act(async () => {
      findButtonByLabel(container, 'Remove friend Alice')!.click();
    });

    const cancelBtn = findButtonByLabel(container, 'Cancel remove');
    expect(cancelBtn).toBeTruthy();
    await act(async () => {
      cancelBtn!.click();
    });

    expect(findButtonByLabel(container, 'Remove friend Alice')).toBeTruthy();
    expect(handleUnfriend).not.toHaveBeenCalled();

    root.unmount();
    document.body.removeChild(container);
  });

  it('does not show the empty friends state when the first refresh has not loaded', async () => {
    const refreshFriends = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useChatContext).mockReturnValue(
      makeCtx({
        friends: [],
        friendsLoaded: false,
        friendsError: true,
        refreshFriends,
      }) as unknown as ReturnType<typeof useChatContext>,
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(FriendsScreen)));
    });

    expect(container.textContent).toContain('Friends temporarily unavailable');
    expect(container.textContent).toContain('service could not be reached after retrying');
    expect(container.textContent).toContain('Friends not loaded');
    expect(container.textContent).not.toContain('No accepted friends yet');

    const retryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Try again',
    );
    expect(retryBtn, 'Retry button must be visible on the unavailable friends state').toBeTruthy();

    await act(async () => {
      retryBtn!.click();
    });

    expect(refreshFriends).toHaveBeenCalledWith({ force: true });

    root.unmount();
    document.body.removeChild(container);
  });

  it('does not show the empty friends state while the first authenticated refresh is pending', async () => {
    vi.mocked(useChatContext).mockReturnValue(
      makeCtx({
        friends: [],
        friendsLoaded: false,
        friendsError: false,
        manager: {} as unknown,
      }) as unknown as ReturnType<typeof useChatContext>,
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(FriendsScreen)));
    });

    expect(container.textContent).toContain('Friends not loaded');
    expect(container.textContent).not.toContain('Friends unavailable');
    expect(container.textContent).not.toContain('No accepted friends yet');

    root.unmount();
    document.body.removeChild(container);
  });
});
