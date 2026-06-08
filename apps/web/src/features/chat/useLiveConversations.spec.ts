import { describe, expect, it } from 'vitest';
import type { Conversation } from './seed';
import { currentUser } from './seed';
import {
  addLiveId,
  liveConversationShell,
  prependConversationIfMissing,
} from './useLiveConversations';

const existingConversation: Conversation = {
  id: 'existing-live',
  type: 'direct',
  participants: [],
  messages: [],
  unreadCount: 0,
};

describe('live conversation helpers', () => {
  it('adds live ids without replacing an unchanged set', () => {
    const existing = new Set(['existing-live']);

    expect(addLiveId(existing, 'existing-live')).toBe(existing);

    const next = addLiveId(existing, 'new-live');
    expect(next).not.toBe(existing);
    expect([...next].sort()).toEqual(['existing-live', 'new-live']);
  });

  it('prepends missing live conversations without duplicating existing ones', () => {
    const conversations = [existingConversation];
    const nextConversation: Conversation = {
      ...existingConversation,
      id: 'new-live',
    };

    expect(prependConversationIfMissing(conversations, existingConversation)).toBe(conversations);
    expect(prependConversationIfMissing(conversations, nextConversation)).toEqual([
      nextConversation,
      existingConversation,
    ]);
  });

  it('creates neutral live conversation shells for joined contacts', () => {
    const shell = liveConversationShell('conv-live', currentUser);

    expect(shell).toMatchObject({
      id: 'conv-live',
      type: 'direct',
      unreadCount: 0,
      messages: [],
    });
    expect(shell.participants[0]).toBe(currentUser);
    expect(shell.participants[1]).toMatchObject({
      id: 'peer-conv-live',
      name: 'New contact',
      isOnline: false,
    });
    expect(shell.participants[1]?.avatar).toMatch(/^data:image\/svg\+xml,/);
  });
});
