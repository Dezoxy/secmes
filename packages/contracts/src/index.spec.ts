import { describe, it, expect } from 'vitest';
import { SendMessageSchema, CipherEnvelopeSchema } from './index.js';

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
});
