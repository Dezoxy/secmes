import { describe, expect, it } from 'vitest';

import { CreateConversationSchema, SendMessageSchema } from './messaging.schemas.js';

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
