import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationList } from './ConversationList';
import { conversations as seedConversations, type Conversation } from './seed';

function renderConversationList(options?: {
  conversations?: Conversation[];
  mutedConversationIds?: ReadonlySet<string>;
}): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      conversations: options?.conversations ?? seedConversations.slice(0, 1),
      selectedId: 'conv-1',
      onSelect: () => undefined,
      mutedConversationIds: options?.mutedConversationIds,
    }),
  );
}

describe('ConversationList', () => {
  it('renders the conversation list without friends or group buttons', () => {
    const html = renderConversationList();

    expect(html).not.toContain('Friends');
    expect(html).not.toContain('New group');
    expect(html).not.toContain('Group');
  });

  it('shows unread badges for unmuted conversations', () => {
    const html = renderConversationList();

    expect(html).toContain('aria-label="2 unread"');
  });

  it('hides unread badges for muted conversations', () => {
    const html = renderConversationList({
      mutedConversationIds: new Set(['conv-1']),
    });

    expect(html).not.toContain('aria-label="2 unread"');
  });
});
