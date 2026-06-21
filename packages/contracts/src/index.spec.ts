import { describe, it, expect } from 'vitest';
import {
  SendMessageSchema,
  CipherEnvelopeSchema,
  MessagePageSchema,
  UploadGrantSchema,
  displayNameSchema,
  UpdateProfileSchema,
  DISPLAY_NAME_ALLOWED,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_PATTERN,
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

  it('accepts a per-message prune-safe cursor, and is back-compat when it is absent', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      senderUserId: '00000000-0000-4000-8000-000000000002',
      clientMessageId: '00000000-0000-4000-8000-000000000003',
      ciphertext: 'Y2lwaGVydGV4dA==',
      alg: 'MLS_1.0',
      epoch: 0,
      attachmentObjectKey: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    // forward: a new server stamps an opaque per-message cursor + keeps the legacy UUID nextCursor
    const withCursor = MessagePageSchema.safeParse({
      messages: [{ ...base, cursor: 'MjAyNi0wMS0wMVQwMDowMDowMC4wMDAwMDBafGFiYw' }],
      nextCursor: '00000000-0000-4000-8000-000000000001',
    });
    expect(withCursor.success).toBe(true);
    // backward: an old server omits `cursor` entirely — still valid (optional)
    const withoutCursor = MessagePageSchema.safeParse({ messages: [base], nextCursor: null });
    expect(withoutCursor.success).toBe(true);
  });

  it('rejects presigned URLs where only attachment object keys are allowed', () => {
    const bad = UploadGrantSchema.safeParse({
      objectKey: 'https://storage.example.com/bucket/object',
      uploadUrl: 'https://storage.example.com/bucket/object?sig=redacted',
    });
    expect(bad.success).toBe(false);
  });
});

// Hardened display-name policy: the only user-controlled free-text identity field, so it must resist
// spoofing/impersonation (zero-width, RTL-override, homoglyph, Zalgo) and abuse (length), not just XSS.
// Adversarial inputs are written with \u escapes — never paste literal invisibles into source.
describe('displayNameSchema', () => {
  it('accepts ordinary Latin names and the allowed punctuation', () => {
    for (const name of ['Brave Otter', 'John_Doe-1', "a.b'c", 'Al', 'A'.repeat(32)]) {
      expect(displayNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('trims and collapses internal whitespace runs', () => {
    expect(displayNameSchema.parse('  Brave   Otter  ')).toBe('Brave Otter');
  });

  it('rejects too-short (after trim) and too-long names', () => {
    expect(displayNameSchema.safeParse(' a ').success).toBe(false); // 1 char after trim
    expect(displayNameSchema.safeParse('').success).toBe(false);
    expect(displayNameSchema.safeParse('A'.repeat(33)).success).toBe(false);
  });

  it('rejects control, zero-width, bidi-override, emoji, and homoglyph characters', () => {
    expect(displayNameSchema.safeParse('Bad\u200bName').success).toBe(false); // zero-width space
    expect(displayNameSchema.safeParse('\u202eevil').success).toBe(false); // RTL override
    expect(displayNameSchema.safeParse('line\nbreak').success).toBe(false); // control char
    expect(displayNameSchema.safeParse('wave \u{1f44b}').success).toBe(false); // emoji
    expect(displayNameSchema.safeParse('\u0410lice').success).toBe(false); // Cyrillic '\u0410'
  });

  it('rejects reserved sentinels case-insensitively', () => {
    expect(displayNameSchema.safeParse('breakglass-admin').success).toBe(false);
    expect(displayNameSchema.safeParse('Breakglass-Admin').success).toBe(false);
  });

  it('feeds UpdateProfileSchema (optional, but validated when present)', () => {
    expect(UpdateProfileSchema.safeParse({}).success).toBe(true);
    expect(UpdateProfileSchema.safeParse({ displayName: 'Brave Otter' }).success).toBe(true);
    expect(UpdateProfileSchema.safeParse({ displayName: 'no\u200bgood' }).success).toBe(false);
  });

  it('exposes the bounds/allow-list as constants so UI + spec + schema stay in lockstep', () => {
    expect(DISPLAY_NAME_MIN).toBe(2);
    expect(DISPLAY_NAME_MAX).toBe(32);
    expect(DISPLAY_NAME_PATTERN).toBe("^[A-Za-z0-9 ._'-]+$");
    expect(DISPLAY_NAME_ALLOWED).toBe("letters, numbers, spaces, and . _ - '");
    // Messages are derived from the constants \u2014 assert the derived text the UI surfaces.
    const tooShort = displayNameSchema.safeParse('a');
    expect(tooShort.success).toBe(false);
    if (!tooShort.success) {
      expect(tooShort.error.issues[0]?.message).toBe(
        `display name must be at least ${DISPLAY_NAME_MIN} characters`,
      );
    }
    const badChar = displayNameSchema.safeParse('bad@name');
    expect(badChar.success).toBe(false);
    if (!badChar.success) {
      expect(badChar.error.issues[0]?.message).toBe(
        `display name may use ${DISPLAY_NAME_ALLOWED} only`,
      );
    }
  });
});
