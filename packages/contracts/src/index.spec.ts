import { describe, it, expect } from 'vitest';
import {
  SendMessageSchema,
  CipherEnvelopeSchema,
  MessagePageSchema,
  UploadGrantSchema,
} from './index.js';

describe('contracts', () => {
  it('accepts a well-formed encrypted envelope', () => {
    const ok = CipherEnvelopeSchema.safeParse({
      ciphertext: 'base64data',
      alg: 'MLS_1.0',
      epoch: 3,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an empty ciphertext (never allow plaintext-shaped junk through)', () => {
    const bad = CipherEnvelopeSchema.safeParse({ ciphertext: '', alg: 'MLS_1.0', epoch: 0 });
    expect(bad.success).toBe(false);
  });

  it('requires a uuid conversationId on send', () => {
    const bad = SendMessageSchema.safeParse({
      conversationId: 'not-a-uuid',
      clientMessageId: '00000000-0000-0000-0000-000000000000',
      envelope: { ciphertext: 'x', alg: 'MLS_1.0', epoch: 0 },
    });
    expect(bad.success).toBe(false);
  });

  it('accepts a ciphertext-only message page', () => {
    const ok = MessagePageSchema.safeParse({
      messages: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          senderUserId: '00000000-0000-4000-8000-000000000002',
          clientMessageId: '00000000-0000-4000-8000-000000000003',
          ciphertext: 'Y2lwaGVydGV4dA==',
          alg: 'MLS_1.0',
          epoch: 0,
          attachmentObjectKey: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects presigned URLs where only attachment object keys are allowed', () => {
    const bad = UploadGrantSchema.safeParse({
      objectKey: 'https://storage.example.com/bucket/object',
      uploadUrl: 'https://storage.example.com/bucket/object?sig=redacted',
    });
    expect(bad.success).toBe(false);
  });
});
