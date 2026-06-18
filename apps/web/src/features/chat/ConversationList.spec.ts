import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ConversationList,
  acceptedFriendsFromConversations,
  addPendingFriendRequest,
  filterAcceptedFriends,
} from './ConversationList';
import { conversations, currentUser } from './seed';

function renderConversationList(options?: { updateReady?: boolean }): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      conversations: conversations.slice(0, 1),
      currentUserProfile: currentUser,
      selectedId: 'conv-1',
      onSelect: () => undefined,
      updateReady: options?.updateReady,
      onApplyUpdate: () => undefined,
    }),
  );
}

describe('ConversationList', () => {
  it('hides the app update action by default', () => {
    const html = renderConversationList();

    expect(html).not.toContain('Update Argus');
  });

  it('renders the friends entry point', () => {
    const html = renderConversationList();

    expect(html).toContain('Friends');
    expect(html).toContain('accepted');
  });

  it('shows a bottom app update action when a PWA update is ready', () => {
    const html = renderConversationList({ updateReady: true });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Update Argus');
    expect(html).toContain('Update');
  });

  it('derives accepted friends from direct conversations only', () => {
    const friends = acceptedFriendsFromConversations(conversations, currentUser.id);
    const names = friends.map((friend) => friend.user.name);

    expect(names).toContain('Sarah Chen');
    expect(names).toContain('Emily Davis');
    expect(names).not.toContain('Marcus Johnson');
    expect(names).not.toContain('Alex Rivera');
  });

  it('filters accepted friends by display name and argus id', () => {
    const friends = acceptedFriendsFromConversations(conversations, currentUser.id);

    expect(filterAcceptedFriends(friends, 'sarah')).toHaveLength(1);
    expect(filterAcceptedFriends(friends, 'argus-bbbbbbbbbbbbbbbb-sarah')).toHaveLength(1);
    expect(filterAcceptedFriends(friends, 'not-a-friend')).toHaveLength(0);
  });

  it('mock-sends a pending friend request without adding duplicates or existing friends', () => {
    const friends = acceptedFriendsFromConversations(conversations, currentUser.id);
    const first = addPendingFriendRequest([], 'argus-hhhhhhhhhhhhhhhh-new', friends);
    const duplicate = addPendingFriendRequest(first, 'ARGUS-HHHHHHHHHHHHHHHH-NEW', friends);
    const existing = addPendingFriendRequest(duplicate, 'Sarah Chen', friends);

    expect(first).toEqual([{ argusId: 'argus-hhhhhhhhhhhhhhhh-new' }]);
    expect(duplicate).toEqual(first);
    expect(existing).toEqual(first);
  });
});
