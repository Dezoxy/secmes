import { describe, expect, it } from 'vitest';
import type { Conversation } from './seed';
import { deriveReadOnlyChatState } from './useChatState';

const directConversation: Conversation = {
  id: 'conv-direct',
  type: 'direct',
  participants: [],
  messages: [],
  unreadCount: 0,
};

const groupConversation: Conversation = {
  id: 'conv-group',
  type: 'group',
  participants: [],
  messages: [],
  unreadCount: 0,
};

describe('deriveReadOnlyChatState', () => {
  it('derives selected direct live verification state', () => {
    const state = deriveReadOnlyChatState({
      conversations: [directConversation, groupConversation],
      selectedId: directConversation.id,
      liveIds: new Set([directConversation.id]),
      numbersByConv: { [directConversation.id]: '123 456' },
      verifiedByConv: { [directConversation.id]: '123 456' },
    });

    expect(state.selectedConversation).toBe(directConversation);
    expect(state.isDirect).toBe(true);
    expect(state.selectedIsLive).toBe(true);
    expect(state.currentNumber).toBe('123 456');
    expect(state.verified).toBe(true);
  });

  it('does not verify group or stale-number selections', () => {
    const groupState = deriveReadOnlyChatState({
      conversations: [directConversation, groupConversation],
      selectedId: groupConversation.id,
      liveIds: new Set([groupConversation.id]),
      numbersByConv: { [groupConversation.id]: '123 456' },
      verifiedByConv: { [groupConversation.id]: '123 456' },
    });
    const staleNumberState = deriveReadOnlyChatState({
      conversations: [directConversation],
      selectedId: directConversation.id,
      liveIds: new Set<string>(),
      numbersByConv: { [directConversation.id]: 'new-number' },
      verifiedByConv: { [directConversation.id]: 'old-number' },
    });

    expect(groupState.isDirect).toBe(false);
    expect(groupState.verified).toBe(false);
    expect(staleNumberState.verified).toBe(false);
  });

  it('returns empty selected state when nothing is selected', () => {
    const state = deriveReadOnlyChatState({
      conversations: [directConversation],
      selectedId: null,
      liveIds: new Set([directConversation.id]),
      numbersByConv: { [directConversation.id]: '123 456' },
      verifiedByConv: { [directConversation.id]: '123 456' },
    });

    expect(state.selectedConversation).toBeUndefined();
    expect(state.isDirect).toBe(false);
    expect(state.selectedIsLive).toBe(false);
    expect(state.currentNumber).toBeNull();
    expect(state.verified).toBe(false);
  });
});
