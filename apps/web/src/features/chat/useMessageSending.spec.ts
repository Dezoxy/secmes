import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from './seed';
import { appendMessageToConversation, patchConversationMessage } from './useMessageSending';

const baseMessage: Message = {
  id: 'msg-1',
  senderId: 'current-user',
  content: 'hello',
  timestamp: new Date('2026-06-08T12:00:00.000Z'),
  status: 'sending',
};

const selectedConversation: Conversation = {
  id: 'conv-selected',
  type: 'direct',
  participants: [],
  messages: [baseMessage],
  unreadCount: 0,
};

const otherConversation: Conversation = {
  id: 'conv-other',
  type: 'direct',
  participants: [],
  messages: [],
  unreadCount: 0,
};

describe('message sending conversation updates', () => {
  it('appends optimistic messages only to the target conversation', () => {
    const nextMessage: Message = {
      id: 'msg-2',
      senderId: 'current-user',
      content: 'next',
      timestamp: new Date('2026-06-08T12:01:00.000Z'),
      status: 'sending',
    };
    const conversations = [selectedConversation, otherConversation];

    const next = appendMessageToConversation(conversations, selectedConversation.id, nextMessage);

    expect(next[0]).not.toBe(selectedConversation);
    expect(next[0]?.messages).toEqual([baseMessage, nextMessage]);
    expect(next[1]).toBe(otherConversation);
    expect(selectedConversation.messages).toEqual([baseMessage]);
  });

  it('patches a sent message without changing unrelated conversations', () => {
    const conversations = [selectedConversation, otherConversation];

    const next = patchConversationMessage(conversations, selectedConversation.id, baseMessage.id, {
      status: 'sent',
      encrypted: true,
    });

    expect(next[0]?.messages[0]).toMatchObject({
      id: baseMessage.id,
      status: 'sent',
      encrypted: true,
    });
    expect(next[1]).toBe(otherConversation);
    expect(selectedConversation.messages[0]?.status).toBe('sending');
    expect(selectedConversation.messages[0]?.encrypted).toBeUndefined();
  });
});
