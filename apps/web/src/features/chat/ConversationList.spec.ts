import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationList } from './ConversationList';
import {
  conversations as seedConversations,
  currentUser,
  type Conversation,
  type User,
} from './seed';
import type { Friend } from '../../lib/api';

function renderConversationList(options?: {
  conversations?: Conversation[];
  currentUserProfile?: User;
  updateReady?: boolean;
  friends?: Friend[];
}): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      conversations: options?.conversations ?? seedConversations.slice(0, 1),
      currentUserProfile: options?.currentUserProfile ?? currentUser,
      selectedId: 'conv-1',
      onSelect: () => undefined,
      updateReady: options?.updateReady,
      onApplyUpdate: () => undefined,
      friends: options?.friends,
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

  it('shows the accepted-friend count from the friends prop', () => {
    const stubFriends: Friend[] = [
      {
        userId: 'peer-one',
        argusId: 'argus-peer-one',
        displayName: 'Peer One',
        avatarSeed: null,
        since: new Date().toISOString(),
      },
      {
        userId: 'peer-two',
        argusId: 'argus-peer-two',
        displayName: 'Peer Two',
        avatarSeed: null,
        since: new Date().toISOString(),
      },
    ];

    const html = renderConversationList({ friends: stubFriends });

    expect(html).toContain('2 accepted');
  });

  it('shows 0 accepted friends when the friends prop is absent (demo / unauthenticated)', () => {
    const html = renderConversationList({ friends: undefined });

    expect(html).toContain('0 accepted');
  });

  it('shows a bottom app update action when a PWA update is ready', () => {
    const html = renderConversationList({ updateReady: true });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Update Argus');
    expect(html).toContain('Update');
  });
});
