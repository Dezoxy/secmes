import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../auth/auth.service.js';
import type { MessagingService } from '../messaging/messaging.service.js';
import { InProcessRealtimeBus } from './in-process-realtime-bus.js';
import { type MessageCreatedEvent } from './realtime-bus.js';
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
      data: { conversationId: CONV, message: e.message },
    });
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
      data: { conversationId: CONV, message: event().message },
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
      data: { conversationId: CONV, message: event().message },
    }); // live still delivered
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
});
