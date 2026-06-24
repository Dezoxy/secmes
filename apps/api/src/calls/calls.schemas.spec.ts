import { describe, expect, it } from 'vitest';

import {
  CallEnvelopeSchema,
  CreateCallRequestSchema,
  TurnCredentialsRequestSchema,
  TurnCredentialsResponseSchema,
  UpdateCallSettingsRequestSchema,
} from './calls.schemas.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
const envelope = { ciphertext: 'base64data', alg: 'MLS_1.0', epoch: 3 };

describe('CallEnvelopeSchema (inbound WS frame)', () => {
  it('accepts a well-formed routing envelope', () => {
    expect(
      CallEnvelopeSchema.safeParse({ conversationId: uuid, callId: uuid, msgSeq: 0, envelope })
        .success,
    ).toBe(true);
  });

  it('is strict — rejects unknown keys (no smuggling SDP past the crypto-blind server)', () => {
    expect(
      CallEnvelopeSchema.safeParse({
        conversationId: uuid,
        callId: uuid,
        msgSeq: 0,
        envelope,
        sdp: 'v=0',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-uuid callId and a negative msgSeq', () => {
    expect(
      CallEnvelopeSchema.safeParse({ conversationId: uuid, callId: 'nope', msgSeq: 0, envelope })
        .success,
    ).toBe(false);
    expect(
      CallEnvelopeSchema.safeParse({ conversationId: uuid, callId: uuid, msgSeq: -1, envelope })
        .success,
    ).toBe(false);
  });

  it('rejects an empty ciphertext and an oversized blob', () => {
    expect(
      CallEnvelopeSchema.safeParse({
        conversationId: uuid,
        callId: uuid,
        msgSeq: 0,
        envelope: { ciphertext: '', alg: 'MLS_1.0', epoch: 0 },
      }).success,
    ).toBe(false);
    expect(
      CallEnvelopeSchema.safeParse({
        conversationId: uuid,
        callId: uuid,
        msgSeq: 0,
        envelope: { ciphertext: 'a'.repeat(65537), alg: 'MLS_1.0', epoch: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('TURN credential schemas', () => {
  it('request is a strict empty object (no callId — not call-scoped)', () => {
    expect(TurnCredentialsRequestSchema.safeParse({}).success).toBe(true);
    expect(TurnCredentialsRequestSchema.safeParse({ callId: uuid }).success).toBe(false);
  });

  it('response carries iceServers + relay policy + ttl', () => {
    expect(
      TurnCredentialsResponseSchema.safeParse({
        iceServers: [
          { urls: ['turns:turn.4rgus.com:5349?transport=tcp'], username: 'u', credential: 'c' },
        ],
        iceTransportPolicy: 'relay',
        ttlSeconds: 600,
      }).success,
    ).toBe(true);
    // ttl must be positive
    expect(
      TurnCredentialsResponseSchema.safeParse({
        iceServers: [{ urls: ['turns:x'] }],
        iceTransportPolicy: 'relay',
        ttlSeconds: 0,
      }).success,
    ).toBe(false);
  });
});

describe('CreateCallRequestSchema', () => {
  it('is audio-only in V1 and strict', () => {
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: uuid, media: 'audio' }).success,
    ).toBe(true);
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: uuid, media: 'video' }).success,
    ).toBe(false);
    expect(
      CreateCallRequestSchema.safeParse({ conversationId: uuid, media: 'audio', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('UpdateCallSettingsRequestSchema', () => {
  it('accepts a relayOnly boolean and rejects extras / wrong types', () => {
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: false }).success).toBe(true);
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: 'no' }).success).toBe(false);
    expect(UpdateCallSettingsRequestSchema.safeParse({ relayOnly: true, other: 1 }).success).toBe(
      false,
    );
  });
});
