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
  CallSignalSchema,
  CallEnvelopeSchema,
  CallMediaSchema,
  SdpSchema,
  IceCandidateSchema,
  TurnCredentialsRequestSchema,
  TurnCredentialsResponseSchema,
  CreateCallRequestSchema,
  UpdateCallSettingsRequestSchema,
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

describe('voip call contracts', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  const base = { callId: UUID, msgSeq: 0, nonce: 'a'.repeat(32), sentAt: 1 };
  const offer = { type: 'offer' as const, sdp: 'v=0\r\n' };

  it('accepts a well-formed audio call.invite signal', () => {
    const ok = CallSignalSchema.safeParse({
      ...base,
      type: 'call.invite',
      media: { audio: true, video: false },
      sdp: offer,
      relayOnly: true,
    });
    expect(ok.success).toBe(true);
  });

  it('routes the discriminated union by type (call.ice carries a candidate)', () => {
    const ice = CallSignalSchema.safeParse({
      ...base,
      type: 'call.ice',
      candidate: { candidate: 'candidate:1 1 udp ...' },
    });
    expect(ice.success).toBe(true);
    // a call.ice without a candidate is rejected (wrong shape for that discriminant)
    expect(CallSignalSchema.safeParse({ ...base, type: 'call.ice' }).success).toBe(false);
  });

  it('rejects an unknown signal type', () => {
    expect(CallSignalSchema.safeParse({ ...base, type: 'call.bogus' }).success).toBe(false);
  });

  it('rejects a call.invite missing its sdp offer', () => {
    const bad = CallSignalSchema.safeParse({
      ...base,
      type: 'call.invite',
      media: { audio: true, video: false },
      relayOnly: true,
    });
    expect(bad.success).toBe(false);
  });

  it('applies enum defaults on teardown/decline signals', () => {
    const hangup = CallSignalSchema.parse({ ...base, type: 'call.hangup' });
    expect(hangup).toMatchObject({ type: 'call.hangup', reason: 'hangup' });
    const decline = CallSignalSchema.parse({ ...base, type: 'call.decline' });
    expect(decline).toMatchObject({ type: 'call.decline', reason: 'declined' });
  });

  it('CallMediaSchema requires booleans; SdpSchema bounds the sdp', () => {
    expect(CallMediaSchema.safeParse({ audio: true, video: false }).success).toBe(true);
    expect(CallMediaSchema.safeParse({ audio: 'yes', video: false }).success).toBe(false);
    expect(SdpSchema.safeParse({ type: 'answer', sdp: 'x' }).success).toBe(true);
    expect(SdpSchema.safeParse({ type: 'pranswer', sdp: 'x' }).success).toBe(false);
    expect(SdpSchema.safeParse({ type: 'offer', sdp: 'x'.repeat(64 * 1024 + 1) }).success).toBe(
      false,
    );
  });

  it('IceCandidateSchema accepts the empty end-of-candidates sentinel', () => {
    expect(IceCandidateSchema.safeParse({ candidate: '' }).success).toBe(true);
  });

  it('CallEnvelopeSchema validates the outer routing wrapper and is strict', () => {
    const envelope = { ciphertext: 'base64data', alg: 'MLS_1.0', epoch: 3 };
    const ok = CallEnvelopeSchema.safeParse({
      conversationId: UUID,
      callId: UUID,
      msgSeq: 0,
      envelope,
    });
    expect(ok.success).toBe(true);
    // unknown keys are rejected (fail-closed) ...
    expect(
      CallEnvelopeSchema.safeParse({
        conversationId: UUID,
        callId: UUID,
        msgSeq: 0,
        envelope,
        sdp: offer,
      }).success,
    ).toBe(false);
    // ... and callId must be a uuid
    expect(
      CallEnvelopeSchema.safeParse({ conversationId: UUID, callId: 'nope', msgSeq: 0, envelope })
        .success,
    ).toBe(false);
  });

  it('TURN credential request is a strict empty object; response carries relay policy + ttl', () => {
    expect(TurnCredentialsRequestSchema.safeParse({}).success).toBe(true);
    expect(TurnCredentialsRequestSchema.safeParse({ callId: UUID }).success).toBe(false);
    const resp = TurnCredentialsResponseSchema.safeParse({
      iceServers: [
        { urls: ['turns:turn.4rgus.com:5349?transport=tcp'], username: 'u', credential: 'c' },
      ],
      iceTransportPolicy: 'relay',
      ttlSeconds: 600,
    });
    expect(resp.success).toBe(true);
  });

  it('CreateCallRequest is audio-only in V1 and strict', () => {
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: UUID, media: 'audio' }).success,
    ).toBe(true);
    // video is a V1.1 widening — rejected by the V1 literal
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: UUID, media: 'video' }).success,
    ).toBe(false);
    // unknown keys rejected
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: UUID, media: 'audio', extra: 1 }).success,
    ).toBe(false);
  });

  it('UpdateCallSettingsRequest accepts a relayOnly boolean and rejects extras', () => {
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: false }).success).toBe(true);
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: 'no' }).success).toBe(false);
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: true, other: 1 }).success).toBe(
      false,
    );
  });
});
