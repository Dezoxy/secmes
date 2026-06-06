import { describe, expect, it } from 'vitest';

import {
  CreateConversationSchema,
  DeliverWelcomeSchema,
  ListMessagesQuerySchema,
  SendMessageSchema,
} from './messaging.schemas.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000'; // a valid RFC-4122 UUID (correct version + variant)

describe('CreateConversationSchema', () => {
  it('accepts 1–256 member uuids', () => {
    expect(CreateConversationSchema.safeParse({ memberUserIds: [uuid] }).success).toBe(true);
  });
  it('rejects an empty list, a non-uuid, and unknown keys', () => {
    expect(CreateConversationSchema.safeParse({ memberUserIds: [] }).success).toBe(false);
    expect(CreateConversationSchema.safeParse({ memberUserIds: ['nope'] }).success).toBe(false);
    expect(CreateConversationSchema.safeParse({ memberUserIds: [uuid], x: 1 }).success).toBe(false);
  });
});

describe('ListMessagesQuerySchema', () => {
  it('defaults limit to 50 and accepts a coerced string limit + uuid cursor', () => {
    expect(ListMessagesQuerySchema.parse({})).toEqual({ limit: 50 });
    const r = ListMessagesQuerySchema.parse({ limit: '20', after: uuid });
    expect(r).toEqual({ limit: 20, after: uuid });
  });
  it('rejects limit out of range, a non-uuid cursor, and unknown keys', () => {
    expect(ListMessagesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListMessagesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListMessagesQuerySchema.safeParse({ after: 'nope' }).success).toBe(false);
    expect(ListMessagesQuerySchema.safeParse({ limit: 10, x: 1 }).success).toBe(false);
  });
});

describe('SendMessageSchema', () => {
  const ok = { clientMessageId: uuid, ciphertext: 'AAAA', alg: 'MLS_1.0', epoch: 0 };

  it('accepts a well-formed message', () => {
    expect(SendMessageSchema.safeParse(ok).success).toBe(true);
  });
  it('rejects non-base64 ciphertext, a negative epoch, and unknown keys', () => {
    expect(SendMessageSchema.safeParse({ ...ok, ciphertext: 'not base64!' }).success).toBe(false);
    expect(SendMessageSchema.safeParse({ ...ok, epoch: -1 }).success).toBe(false);
    expect(SendMessageSchema.safeParse({ ...ok, surprise: true }).success).toBe(false);
  });
  it('rejects an attachment key that looks like a URL (presigned-URL guard)', () => {
    expect(
      SendMessageSchema.safeParse({ ...ok, attachmentObjectKey: 'https://evil/x' }).success,
    ).toBe(false);
    expect(
      SendMessageSchema.safeParse({ ...ok, attachmentObjectKey: 'tenant/abc/blob1' }).success,
    ).toBe(true);
  });
});

describe('DeliverWelcomeSchema', () => {
  const ok = {
    recipientUserId: uuid,
    recipientDeviceId: uuid,
    welcome: 'AAAA',
    ratchetTree: 'BBBB',
  };

  it('accepts a well-formed welcome delivery', () => {
    expect(DeliverWelcomeSchema.safeParse(ok).success).toBe(true);
  });
  it('rejects a non-uuid recipient/device, non-base64 blobs, empty blobs, missing device, unknown keys', () => {
    expect(DeliverWelcomeSchema.safeParse({ ...ok, recipientUserId: 'nope' }).success).toBe(false);
    expect(DeliverWelcomeSchema.safeParse({ ...ok, recipientDeviceId: 'nope' }).success).toBe(
      false,
    );
    expect(DeliverWelcomeSchema.safeParse({ ...ok, welcome: 'not base64!' }).success).toBe(false);
    expect(DeliverWelcomeSchema.safeParse({ ...ok, ratchetTree: '' }).success).toBe(false);
    const noDevice = { recipientUserId: uuid, welcome: 'AAAA', ratchetTree: 'BBBB' };
    expect(DeliverWelcomeSchema.safeParse(noDevice).success).toBe(false); // device is required
    expect(DeliverWelcomeSchema.safeParse({ ...ok, surprise: true }).success).toBe(false);
  });
  it('rejects a welcome blob over the 32 KiB bound (DoS guard)', () => {
    expect(DeliverWelcomeSchema.safeParse({ ...ok, welcome: 'A'.repeat(32769) }).success).toBe(
      false,
    );
  });
});
