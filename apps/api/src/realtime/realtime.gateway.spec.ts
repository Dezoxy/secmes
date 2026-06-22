import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../auth/auth.service.js';
import type { MessagingService } from '../messaging/messaging.service.js';
import { InProcessRealtimeBus } from './in-process-realtime-bus.js';
import { type MessageCreatedEvent, type ReceiptAdvancedEvent } from './realtime-bus.js';
import { RealtimeGateway } from './realtime.gateway.js';

// Deterministic gateway tests with MOCK sockets — no real WebSocket server. Validates the security
// logic: auth-required, subscribe-membership, tenant/conversation-scoped delivery, auth deadline.

const CONV = '550e8400-e29b-41d4-a716-446655440000';
const CONV2 = '550e8400-e29b-41d4-a716-446655440001';

interface MockSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}
const mkSocket = (): MockSocket => ({ send: vi.fn(), close: vi.fn(), readyState: 1 /* OPEN */ });
const lastSend = (s: MockSocket): { event: string; data: unknown } | undefined => {
  const call = s.send.mock.calls.at(-1);
  return call ? (JSON.parse(call[0] as string) as { event: string; data: unknown }) : undefined;
};
const sock = (s: MockSocket) => s as unknown as Parameters<RealtimeGateway['handleConnection']>[0];

describe('RealtimeGateway', () => {
  let bus: InProcessRealtimeBus;
  let auth: { verify: ReturnType<typeof vi.fn> };
  let messaging: { isMember: ReturnType<typeof vi.fn> };
  let gw: RealtimeGateway;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new InProcessRealtimeBus();
    auth = { verify: vi.fn() };
    messaging = { isMember: vi.fn() };
    gw = new RealtimeGateway(
      auth as unknown as AuthService,
      messaging as unknown as MessagingService,
      bus,
    );
    gw.onModuleInit(); // wire bus → deliver
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Connect + authenticate a socket as `sub`/`tenantId`. */
  async function authed(s: MockSocket, sub = 'alice', tenantId = 'T1'): Promise<void> {
    gw.handleConnection(sock(s));
    auth.verify.mockResolvedValue({ sub, tenantId });
    await gw.onAuth(sock(s), { token: 'good-token' });
  }

  const event = (over: Partial<MessageCreatedEvent> = {}): MessageCreatedEvent => ({
    tenantId: 'T1',
    conversationId: CONV,
    message: {
      id: 'm1',
      senderUserId: 'u-sender',
      clientMessageId: 'c1',
      ciphertext: 'b3BhcXVl',
      alg: 'MLS_1.0',
      epoch: 0,
      attachmentObjectKey: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    ...over,
  });

  it('authenticates a socket with a valid first-frame token', async () => {
    const s = mkSocket();
    await authed(s);
    expect(auth.verify).toHaveBeenCalledWith('good-token');
    expect(lastSend(s)).toEqual({ event: 'ready', data: { sub: 'alice' } });
    expect(s.close).not.toHaveBeenCalled();
  });

  it('closes the socket on a missing or invalid token', async () => {
    const s1 = mkSocket();
    gw.handleConnection(sock(s1));
    await gw.onAuth(sock(s1), {}); // no token
    expect(s1.close).toHaveBeenCalledWith(4400, expect.any(String));

    const s2 = mkSocket();
    gw.handleConnection(sock(s2));
    auth.verify.mockRejectedValue(new Error('bad'));
    await gw.onAuth(sock(s2), { token: 'forged' });
    expect(s2.close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  it('closes a socket that never authenticates within the deadline', () => {
    const s = mkSocket();
    gw.handleConnection(sock(s));
    vi.advanceTimersByTime(10_000);
    expect(s.close).toHaveBeenCalledWith(4408, expect.any(String));
  });

  it('refuses subscribe before authentication', async () => {
    const s = mkSocket();
    gw.handleConnection(sock(s));
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    expect(s.close).toHaveBeenCalledWith(4401, expect.any(String));
    expect(messaging.isMember).not.toHaveBeenCalled();
  });

  it('rejects an invalid conversationId and a non-member subscribe (no join)', async () => {
    const s = mkSocket();
    await authed(s);

    await gw.onSubscribe(sock(s), { conversationId: 'not-a-uuid' });
    expect(lastSend(s)).toEqual({ event: 'error', data: { message: 'invalid conversationId' } });
    expect(messaging.isMember).not.toHaveBeenCalled();

    messaging.isMember.mockResolvedValue(false);
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    expect(lastSend(s)).toEqual({ event: 'error', data: { message: 'conversation not found' } });

    // Not joined → a delivery for that conversation does not reach it.
    s.send.mockClear();
    bus.emitMessageCreated(event());
    expect(s.send).not.toHaveBeenCalled();
  });

  it('delivers a stored message to a subscribed member', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    expect(lastSend(s)).toEqual({ event: 'subscribed', data: { conversationId: CONV } });

    s.send.mockClear();
    const e = event();
    bus.emitMessageCreated(e);
    expect(lastSend(s)).toEqual({
      event: 'message',
      data: { conversationId: CONV, message: e.message, deliverySeq: 1, deliveryPrevSeq: null },
    });
  });

  const receiptEvent = (over: Partial<ReceiptAdvancedEvent> = {}): ReceiptAdvancedEvent => ({
    tenantId: 'T1',
    conversationId: CONV,
    userId: 'u-peer',
    status: 'read',
    throughMessageId: 'm1',
    ...over,
  });

  it('delivers a receipt advance to a subscribed member (metadata only)', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });

    s.send.mockClear();
    bus.emitReceiptAdvanced(receiptEvent());
    expect(lastSend(s)).toEqual({
      event: 'receipt',
      data: { conversationId: CONV, userId: 'u-peer', status: 'read', throughMessageId: 'm1' },
    });
  });

  it('a receipt never reaches an unsubscribed socket or crosses a tenant', async () => {
    // alice in T1 subscribed to CONV; carol in T2 subscribed to the same id value (different room)
    const a = mkSocket();
    await authed(a, 'alice', 'T1');
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(a), { conversationId: CONV });
    const c = mkSocket();
    await authed(c, 'carol', 'T2');
    await gw.onSubscribe(sock(c), { conversationId: CONV });

    a.send.mockClear();
    c.send.mockClear();
    bus.emitReceiptAdvanced(receiptEvent({ tenantId: 'T1', conversationId: CONV })); // → only alice
    expect(lastSend(a)).toEqual({
      event: 'receipt',
      data: { conversationId: CONV, userId: 'u-peer', status: 'read', throughMessageId: 'm1' },
    });
    expect(c.send).not.toHaveBeenCalled();

    a.send.mockClear();
    bus.emitReceiptAdvanced(receiptEvent({ conversationId: CONV2 })); // other conversation
    expect(a.send).not.toHaveBeenCalled();
  });

  it('does not join a socket that disconnects during the membership lookup (no leak)', async () => {
    const s = mkSocket();
    await authed(s);
    let resolveMember!: (v: boolean) => void;
    messaging.isMember.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveMember = r;
      }),
    );
    const pending = gw.onSubscribe(sock(s), { conversationId: CONV });
    gw.handleDisconnect(sock(s)); // disconnect before isMember resolves
    resolveMember(true);
    await pending;

    s.send.mockClear();
    bus.emitMessageCreated(event());
    expect(s.send).not.toHaveBeenCalled(); // never joined the room → no delivery, no leaked dead socket
  });

  it('fan-out is scoped: never crosses tenant or conversation', async () => {
    // alice in T1 subscribed to CONV
    const a = mkSocket();
    await authed(a, 'alice', 'T1');
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(a), { conversationId: CONV });

    // carol in T2 subscribed to the SAME conversationId value (different tenant room)
    const c = mkSocket();
    await authed(c, 'carol', 'T2');
    await gw.onSubscribe(sock(c), { conversationId: CONV });

    a.send.mockClear();
    c.send.mockClear();

    bus.emitMessageCreated(event({ tenantId: 'T1', conversationId: CONV })); // → only alice
    expect(lastSend(a)).toEqual({
      event: 'message',
      data: {
        conversationId: CONV,
        message: event().message,
        deliverySeq: 1,
        deliveryPrevSeq: null,
      },
    });
    expect(c.send).not.toHaveBeenCalled();

    a.send.mockClear();
    bus.emitMessageCreated(event({ tenantId: 'T1', conversationId: CONV2 })); // other conversation
    expect(a.send).not.toHaveBeenCalled();
  });

  it('a dead socket does not abort fan-out to the rest of the room', async () => {
    const dead = mkSocket();
    const live = mkSocket();
    await authed(dead, 'alice', 'T1');
    await authed(live, 'bob', 'T1');
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(dead), { conversationId: CONV }); // added first → iterated first
    await gw.onSubscribe(sock(live), { conversationId: CONV });

    dead.send.mockImplementation(() => {
      throw new Error('socket closed'); // ws throws on a dead connection
    });
    live.send.mockClear();
    expect(() => bus.emitMessageCreated(event())).not.toThrow();
    expect(lastSend(live)).toEqual({
      event: 'message',
      data: {
        conversationId: CONV,
        message: event().message,
        deliverySeq: 1,
        deliveryPrevSeq: null,
      },
    }); // live still delivered
  });

  it('re-subscribing to an already-joined room ACKs without a second membership lookup', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    expect(messaging.isMember).toHaveBeenCalledTimes(1);

    // Same conversation again → idempotent ACK, no extra DB lookup (no hammering via repeat-subscribe).
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    expect(messaging.isMember).toHaveBeenCalledTimes(1);
    expect(lastSend(s)).toEqual({ event: 'subscribed', data: { conversationId: CONV } });
  });

  it('rate-limits new-room subscribe frames per socket (bounds the isMember DB lookups)', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(false); // every distinct UUID is a non-member → fresh DB lookup

    const uuid = (i: number) =>
      `550e8400-e29b-41d4-a716-${(446655550000 + i).toString().slice(-12)}`;
    // 120 distinct-UUID subscribes are allowed (each hits isMember)...
    for (let i = 0; i < 120; i++) await gw.onSubscribe(sock(s), { conversationId: uuid(i) });
    expect(messaging.isMember).toHaveBeenCalledTimes(120);

    // ...the 121st in the same window is rejected BEFORE the DB lookup.
    await gw.onSubscribe(sock(s), { conversationId: uuid(120) });
    expect(lastSend(s)).toEqual({ event: 'error', data: { message: 'rate limited' } });
    expect(messaging.isMember).toHaveBeenCalledTimes(120); // no extra lookup

    // The window resets after 60s → subscribes flow again.
    vi.advanceTimersByTime(60_000);
    await gw.onSubscribe(sock(s), { conversationId: uuid(121) });
    expect(messaging.isMember).toHaveBeenCalledTimes(121);
  });

  it('disconnect removes the socket from its rooms', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });

    gw.handleDisconnect(sock(s));
    s.send.mockClear();
    bus.emitMessageCreated(event());
    expect(s.send).not.toHaveBeenCalled(); // no longer subscribed
  });

  // ── Track 3 item D: per-(socket, conversation) transport delivery counter ─────────────────────
  interface MsgFrame {
    conversationId: string;
    message: { epoch: number };
    deliverySeq?: number;
    deliveryPrevSeq?: number | null;
  }
  /** All `message` frames a socket was sent, decoded, in order. */
  const messageFrames = (s: MockSocket): MsgFrame[] =>
    s.send.mock.calls
      .map((c) => JSON.parse(c[0] as string) as { event: string; data: MsgFrame })
      .filter((f) => f.event === 'message')
      .map((f) => f.data);
  const seqChain = (s: MockSocket): Array<[number | undefined, number | null | undefined]> =>
    messageFrames(s).map((f) => [f.deliverySeq, f.deliveryPrevSeq]);

  it('stamps an INDEPENDENT per-socket delivery counter (1,2,3… with a prevSeq chain)', async () => {
    const a = mkSocket();
    const b = mkSocket();
    await authed(a, 'alice', 'T1');
    await authed(b, 'bob', 'T1');
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(a), { conversationId: CONV });
    await gw.onSubscribe(sock(b), { conversationId: CONV });

    a.send.mockClear();
    b.send.mockClear();
    bus.emitMessageCreated(event());
    bus.emitMessageCreated(event());
    bus.emitMessageCreated(event());

    // Each socket counts only the frames IT received: 1 (prev null), 2 (prev 1), 3 (prev 2), independently.
    const expected: Array<[number, number | null]> = [
      [1, null],
      [2, 1],
      [3, 2],
    ];
    expect(seqChain(a)).toEqual(expected);
    expect(seqChain(b)).toEqual(expected);
  });

  it('advances the counter even when a send throws, so the gap is visible to the client', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });

    s.send.mockClear();
    s.send.mockImplementationOnce(() => {
      throw new Error('socket write failed'); // ws throws on a dead connection (seq 1 never lands)
    });
    expect(() => bus.emitMessageCreated(event())).not.toThrow(); // seq 1 — write throws, swallowed
    bus.emitMessageCreated(event()); // seq 2 — delivered

    // The counter advanced through the failed write, so the delivered frame is seq 2 with prevSeq 1 — a
    // client that only received this frame sees prevSeq (1) ≠ its baseline and re-fetches.
    const delivered = messageFrames(s).at(-1)!;
    expect([delivered.deliverySeq, delivered.deliveryPrevSeq]).toEqual([2, 1]);
  });

  it('restarts the counter at 1 after member-removal + re-subscribe', async () => {
    const s = mkSocket();
    await authed(s, 'alice', 'T1');
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    bus.emitMessageCreated(event()); // seq 1
    bus.emitMessageCreated(event()); // seq 2

    // Removed from the conversation by a commit → the room's counter is dropped with the room membership.
    bus.emitMemberRemoved({ tenantId: 'T1', conversationId: CONV, removedSubs: ['alice'] });

    // Re-added + re-subscribes → the counter restarts at 1 (prevSeq null), not 3.
    s.send.mockClear();
    await gw.onSubscribe(sock(s), { conversationId: CONV });
    bus.emitMessageCreated(event());
    expect(seqChain(s)).toEqual([[1, null]]);
  });

  it('increments per MESSAGE within one epoch (the counter is not the MLS epoch)', async () => {
    const s = mkSocket();
    await authed(s);
    messaging.isMember.mockResolvedValue(true);
    await gw.onSubscribe(sock(s), { conversationId: CONV });

    s.send.mockClear();
    const at = (id: string): Partial<MessageCreatedEvent> => ({
      message: { ...event().message, id, epoch: 0 },
    });
    bus.emitMessageCreated(event(at('m1')));
    bus.emitMessageCreated(event(at('m2')));
    bus.emitMessageCreated(event(at('m3')));

    const frames = messageFrames(s);
    expect(frames.map((f) => f.deliverySeq)).toEqual([1, 2, 3]); // three distinct seqs…
    expect(frames.every((f) => f.message.epoch === 0)).toBe(true); // …all at the same epoch
  });
});
