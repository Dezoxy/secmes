import { describe, expect, it, vi } from 'vitest';

import { createCallSignaling } from './call-signaling';
import type { IncomingCallSignalFrame, MessageSocket } from './ws';

// ── Fake Conversation ─────────────────────────────────────────────────────────────────────────────

const ENCRYPTED_WIRE = new Uint8Array([1, 2, 3, 4]);
const PEER_IDENTITY = 'peerUserId:peer-device-uuid';
const LOCAL_IDENTITY = 'localUserId:local-device-uuid';
// UUIDs must match [1-8] version nibble and [89abAB] variant nibble
const CALL_ID = '11111111-1111-1111-8111-111111111111';
const CONV_ID = '22222222-2222-2222-8222-222222222222';
const SENDER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeFakeConversation({
  encryptResult = ENCRYPTED_WIRE,
  decryptResult = { plaintext: '', senderIdentity: PEER_IDENTITY },
  decryptError,
  epoch = 0,
}: {
  encryptResult?: Uint8Array;
  decryptResult?: { plaintext: string; senderIdentity: string };
  decryptError?: Error;
  epoch?: number;
} = {}) {
  return {
    epoch,
    encrypt: vi.fn().mockResolvedValue(encryptResult),
    decryptAuthenticated: decryptError
      ? vi.fn().mockRejectedValue(decryptError)
      : vi.fn().mockResolvedValue(decryptResult),
  };
}

// ── Fake MessageSocket ────────────────────────────────────────────────────────────────────────────

function makeFakeSocket(): MessageSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    subscribe: vi.fn(),
    sendCallSignal: vi.fn((frame) => sent.push({ event: 'call.signal', data: frame })),
    sendCallRelease: vi.fn(),
    close: vi.fn(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

/** Build a valid call.accept signal payload for use in send() tests. */
const ACCEPT_PAYLOAD = {
  type: 'call.accept' as const,
  sdp: { type: 'answer' as const, sdp: 'v=0\r\nfake' },
};

/** Build a plausible encrypted frame from the gateway. */
function makeInboundFrame(
  overrides: Partial<IncomingCallSignalFrame> = {},
): IncomingCallSignalFrame {
  return {
    callId: CALL_ID,
    conversationId: CONV_ID,
    msgSeq: 0,
    senderUserId: SENDER_USER_ID,
    deliverySeq: 1,
    envelope: { ciphertext: 'AQIDBA==', alg: 'MLS_1.0', epoch: 0 }, // base64 of [1,2,3,4]
    ...overrides,
  };
}

/** A valid CallSignal JSON that decryptAuthenticated would return as plaintext. */
function signalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'call.accept',
    callId: CALL_ID,
    msgSeq: 0,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.slice(0, 32),
    sentAt: 1000,
    sdp: { type: 'answer', sdp: 'v=0\r\nfake' },
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

describe('createCallSignaling — send()', () => {
  it('sends an encrypted envelope over the socket', async () => {
    const conv = makeFakeConversation();
    const socket = makeFakeSocket();
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket,
      onSignal: vi.fn(),
    });

    await sig.send(ACCEPT_PAYLOAD);

    expect(conv.encrypt).toHaveBeenCalledOnce();
    expect(socket.sendCallSignal).toHaveBeenCalledOnce();
    const frame = (socket.sendCallSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(frame.callId).toBe(CALL_ID);
    expect(frame.conversationId).toBe(CONV_ID);
    expect(frame.msgSeq).toBe(0);
    expect(typeof frame.envelope.ciphertext).toBe('string');
    expect(frame.envelope.ciphertext.length).toBeGreaterThan(0);
    expect(frame.envelope.alg).toBe('MLS_1.0');
    expect(typeof frame.envelope.epoch).toBe('number');
  });

  it('calls saveState after encrypt and before send', async () => {
    const order: string[] = [];
    const conv = {
      epoch: 3,
      encrypt: vi.fn().mockImplementation(async () => {
        order.push('encrypt');
        return ENCRYPTED_WIRE;
      }),
    };
    const saveState = vi.fn().mockImplementation(async () => {
      order.push('saveState');
    });
    const socket = makeFakeSocket();
    const origSend = socket.sendCallSignal as ReturnType<typeof vi.fn>;
    origSend.mockImplementation((...args: unknown[]) => {
      order.push('send');
      return (socket as { sent: unknown[] }).sent.push({ event: 'call.signal', data: args[0] });
    });

    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket,
      onSignal: vi.fn(),
      saveState,
    });

    await sig.send(ACCEPT_PAYLOAD);

    expect(saveState).toHaveBeenCalledOnce();
    expect(order).toEqual(['encrypt', 'saveState', 'send']);
  });

  it('increments msgSeq on each send', async () => {
    const conv = makeFakeConversation();
    const socket = makeFakeSocket();
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket,
      onSignal: vi.fn(),
    });

    await sig.send(ACCEPT_PAYLOAD);
    await sig.send(ACCEPT_PAYLOAD);

    const calls = (socket.sendCallSignal as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].msgSeq).toBe(0);
    expect(calls[1]![0].msgSeq).toBe(1);
  });

  it('includes a 32-character nonce in the encrypted plaintext', async () => {
    let capturedPlaintext = '';
    const conv = {
      encrypt: vi.fn().mockImplementation((s: string) => {
        capturedPlaintext = s;
        return Promise.resolve(ENCRYPTED_WIRE);
      }),
    };
    const socket = makeFakeSocket();
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket,
      onSignal: vi.fn(),
    });

    await sig.send(ACCEPT_PAYLOAD);

    const inner = JSON.parse(capturedPlaintext) as { nonce: string };
    expect(inner.nonce).toHaveLength(32);
  });
});

describe('createCallSignaling — receiveFrame()', () => {
  it('dispatches a valid inbound signal to onSignal', async () => {
    const onSignal = vi.fn();
    const conv = makeFakeConversation({
      decryptResult: { plaintext: signalJson(), senderIdentity: PEER_IDENTITY },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onSignal).toHaveBeenCalledOnce();
    expect((onSignal.mock.calls[0]![0] as { type: string }).type).toBe('call.accept');
  });

  it('drops a replayed frame (same msgSeq from same sender)', async () => {
    const onSignal = vi.fn();
    const conv = makeFakeConversation({
      decryptResult: { plaintext: signalJson(), senderIdentity: PEER_IDENTITY },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
    });

    const frame = makeInboundFrame({ msgSeq: 5 });
    await sig.receiveFrame(frame); // accepted
    await sig.receiveFrame(frame); // replay — dropped
    expect(onSignal).toHaveBeenCalledTimes(1);
  });

  it('drops a loopback frame (senderIdentity === localIdentity)', async () => {
    const onSignal = vi.fn();
    const conv = makeFakeConversation({
      decryptResult: { plaintext: signalJson(), senderIdentity: LOCAL_IDENTITY },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('drops a cross-call frame (signal.callId !== our callId)', async () => {
    const onSignal = vi.fn();
    const wrongCallId = '99999999-9999-1999-9999-999999999999';
    const conv = makeFakeConversation({
      decryptResult: {
        plaintext: signalJson({ callId: wrongCallId }),
        senderIdentity: PEER_IDENTITY,
      },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('calls onError and does not dispatch when MLS decryption fails', async () => {
    const onSignal = vi.fn();
    const onError = vi.fn();
    const conv = makeFakeConversation({
      decryptError: new Error('MLS auth failed'),
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
      onError,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onSignal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('calls onError and does not dispatch when the signal schema is invalid', async () => {
    const onSignal = vi.fn();
    const onError = vi.fn();
    const conv = makeFakeConversation({
      decryptResult: {
        plaintext: JSON.stringify({ type: 'unknown.event', callId: CALL_ID }),
        senderIdentity: PEER_IDENTITY,
      },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal,
      onError,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onSignal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('calls onError when the plaintext is not valid JSON', async () => {
    const onError = vi.fn();
    const conv = makeFakeConversation({
      decryptResult: { plaintext: 'not-json{{{', senderIdentity: PEER_IDENTITY },
    });
    const sig = createCallSignaling({
      conversation: conv as never,
      localIdentity: LOCAL_IDENTITY,
      callId: CALL_ID,
      conversationId: CONV_ID,
      socket: makeFakeSocket(),
      onSignal: vi.fn(),
      onError,
    });

    await sig.receiveFrame(makeInboundFrame());
    expect(onError).toHaveBeenCalledOnce();
  });
});
