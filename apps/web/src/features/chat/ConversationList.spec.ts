import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationList } from './ConversationList';
import { conversations as seedConversations, type Conversation } from './seed';

function renderConversationList(options?: {
  conversations?: Conversation[];
  updateReady?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      conversations: options?.conversations ?? seedConversations.slice(0, 1),
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

  it('renders the conversation list without friends or group buttons', () => {
    const html = renderConversationList();

    expect(html).not.toContain('Friends');
    expect(html).not.toContain('New group');
    expect(html).not.toContain('Group');
  });

  it('shows a bottom app update action when a PWA update is ready', () => {
    const html = renderConversationList({ updateReady: true });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Update Argus');
    expect(html).toContain('Update');
  });
});
