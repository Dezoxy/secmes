import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../lib/keystore';
import type { AttachmentRef } from '../../lib/message-envelope';
import type { DecryptedMessage } from '../../lib/messaging';
import type { Conversation, Message } from './seed';
import {
  decryptedToMessage,
  decryptedToStoredMessage,
  mergeIncomingMessages,
  refToUiAttachment,
  storedToMessage,
} from './useConversationBackfill';
import { prependConversationIfMissing, replaceOrPrependConversation } from './useLiveConversations';

const imageRef: AttachmentRef = {
  objectKey: 'tenant/conv/image',
  key: 'content-key',
  iv: 'iv',
  name: 'proof.png',
  mime: 'image/png',
  size: 2 * 1024 * 1024,
};

const fileRef: AttachmentRef = {
  ...imageRef,
  objectKey: 'tenant/conv/file',
  name: 'notes.pdf',
  mime: 'application/pdf',
  size: 512 * 1024,
};

const baseMessage: Message = {
  id: 'm-existing',
  senderId: 'bob',
  content: 'already here',
  timestamp: new Date('2026-06-08T12:00:00.000Z'),
  status: 'read',
  encrypted: true,
};

const selectedConversation: Conversation = {
  id: 'conv-live',
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

function decrypted(overrides: Partial<DecryptedMessage>): DecryptedMessage {
  return {
    serverId: 'm-new',
    senderUserId: 'alice',
    clientMessageId: 'client-new',
    text: 'hello',
    attachments: [],
    createdAt: '2026-06-08T12:01:00.000Z',
    ...overrides,
  };
}

describe('conversation backfill helpers', () => {
  it('maps encrypted attachment refs to UI attachments without creating server URLs', () => {
    expect(refToUiAttachment(imageRef)).toMatchObject({
      id: 'att-tenant/conv/image',
      type: 'image',
      name: 'proof.png',
      size: '2.0 MB',
      ref: imageRef,
    });
    expect(refToUiAttachment(fileRef)).toMatchObject({
      id: 'att-tenant/conv/file',
      type: 'file',
      name: 'notes.pdf',
      size: '0.5 MB',
      ref: fileRef,
    });
    expect(refToUiAttachment(imageRef)).not.toHaveProperty('url');
  });

  it('maps sealed history entries back to UI messages', () => {
    const stored: StoredMessage = {
      id: 'm-stored',
      senderId: 'peer',
      content: 'from disk',
      timestamp: '2026-06-08T12:03:00.000Z',
      status: 'read',
      encrypted: true,
      attachments: [imageRef],
    };

    expect(storedToMessage(stored)).toMatchObject({
      id: 'm-stored',
      senderId: 'peer',
      content: 'from disk',
      status: 'read',
      encrypted: true,
      attachments: [refToUiAttachment(imageRef)],
    });
    expect(storedToMessage(stored).timestamp).toEqual(new Date(stored.timestamp));
  });

  it('maps decrypted incoming messages to UI and sealed-history shapes', () => {
    const incoming = decrypted({ attachments: [fileRef] });

    expect(decryptedToMessage(incoming)).toMatchObject({
      id: incoming.serverId,
      senderId: incoming.senderUserId,
      content: incoming.text,
      status: 'read',
      encrypted: true,
      attachments: [refToUiAttachment(fileRef)],
    });
    expect(decryptedToStoredMessage(incoming)).toEqual({
      id: incoming.serverId,
      senderId: incoming.senderUserId,
      content: incoming.text,
      timestamp: incoming.createdAt,
      status: 'read',
      encrypted: true,
      attachments: [fileRef],
    });
  });

  it('dedupes by server id and sorts incoming messages by timestamp', () => {
    const conversations = [selectedConversation, otherConversation];
    const earlier = decrypted({
      serverId: 'm-earlier',
      text: 'earlier',
      createdAt: '2026-06-08T11:59:00.000Z',
    });
    const duplicate = decrypted({
      serverId: baseMessage.id,
      text: 'duplicate',
      createdAt: '2026-06-08T12:02:00.000Z',
    });
    const later = decrypted({
      serverId: 'm-later',
      text: 'later',
      createdAt: '2026-06-08T12:02:00.000Z',
    });

    const next = mergeIncomingMessages(conversations, selectedConversation.id, [
      duplicate,
      later,
      earlier,
    ]);

    expect(next[0]).not.toBe(selectedConversation);
    expect(next[0]?.messages.map((message) => message.id)).toEqual([
      earlier.serverId,
      baseMessage.id,
      later.serverId,
    ]);
    expect(next[0]?.messages.map((message) => message.content)).toEqual([
      'earlier',
      baseMessage.content,
      'later',
    ]);
    expect(next[1]).toBe(otherConversation);
  });

  it('keeps conversation references stable when no fresh messages apply', () => {
    const conversations = [selectedConversation, otherConversation];
    const next = mergeIncomingMessages(conversations, selectedConversation.id, [
      decrypted({ serverId: baseMessage.id }),
    ]);

    expect(next[0]).toBe(selectedConversation);
    expect(next[1]).toBe(otherConversation);
  });
});

// ── prependConversationIfMissing ────────────────────────────────────────────

describe('prependConversationIfMissing', () => {
  const conv: Conversation = {
    id: 'conv-a',
    type: 'direct',
    participants: [],
    messages: [],
    unreadCount: 0,
  };

  it('prepends when the id is absent', () => {
    const result = prependConversationIfMissing([], conv);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(conv);
  });

  it('is a no-op when the id already exists', () => {
    const existing = [conv];
    const other: Conversation = { ...conv, id: 'conv-b' };
    const result = prependConversationIfMissing(existing, other);
    // other has a different id — should prepend
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(other);

    // same id — no-op
    const noop = prependConversationIfMissing(existing, { ...conv, messages: [baseMessage] });
    expect(noop).toBe(existing); // reference-stable
  });
});

// ── replaceOrPrependConversation ────────────────────────────────────────────

describe('replaceOrPrependConversation', () => {
  const placeholder: Conversation = {
    id: 'conv-a',
    type: 'direct',
    participants: [],
    messages: [],
    unreadCount: 0,
  };

  it('prepends when the id is absent', () => {
    const result = replaceOrPrependConversation([], placeholder);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(placeholder);
  });

  it('replaces an existing entry when the id matches (live path wins over placeholder)', () => {
    const live: Conversation = { ...placeholder, messages: [baseMessage] };
    const result = replaceOrPrependConversation([placeholder], live);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(live);
  });

  it('preserves surrounding entries and their order when replacing', () => {
    const before: Conversation = { ...placeholder, id: 'conv-before' };
    const after: Conversation = { ...placeholder, id: 'conv-after' };
    const live: Conversation = { ...placeholder, messages: [baseMessage] };
    const result = replaceOrPrependConversation([before, placeholder, after], live);
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('conv-before');
    expect(result[1]).toBe(live);
    expect(result[2]!.id).toBe('conv-after');
  });
});
