import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageSocket,
  defaultWsUrl,
  type IncomingMessage,
  type MessageSocketStatus,
} from './ws';

// A minimal in-test WebSocket: records sends, lets the test drive open/message/close. jsdom/node have no
// WebSocket, so the client takes an injectable impl. OPEN/CLOSED match the DOM numeric readyState.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close', {});
  }
  // --- test drivers ---
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1; // OPEN
    this.emit('open', {});
  }
  deliver(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

const Impl = FakeWebSocket as unknown as typeof WebSocket;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// Wait for a condition instead of a fixed real-time sleep: a 1–5 ms reconnect backoff slips past a 10 ms
// window under CPU contention, so poll for the actual effect up to a generous cap (load-robust).
const waitFor = async (cond: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 1));
  }
};
const last = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
const parsed = (ws: FakeWebSocket): { event: string; data: unknown }[] =>
  ws.sent.map((s) => JSON.parse(s) as { event: string; data: unknown });

describe('createMessageSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('authenticates in the FIRST FRAME and never puts the token in the URL', async () => {
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 'secret-token',
      onMessage: () => {},
      WebSocketImpl: Impl,
    });
    last().open();
    await flush();

    expect(last().url).toBe('wss://host/ws'); // token NOT in the URL/query
    expect(parsed(last())[0]).toEqual({ event: 'auth', data: { token: 'secret-token' } });
    sock.close();
  });

  it('subscribes tracked conversations on `ready` (and immediately once authenticated) + fires onReady', async () => {
    const onReady = vi.fn();
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: () => {},
      onReady,
      WebSocketImpl: Impl,
    });
    sock.subscribe('11111111-1111-1111-1111-111111111111'); // before auth — queued, not sent yet
    last().open();
    await flush();
    expect(parsed(last()).some((f) => f.event === 'subscribe')).toBe(false);

    last().deliver({ event: 'ready', data: { sub: 's' } });
    expect(onReady).toHaveBeenCalledTimes(1);
    const subs = parsed(last()).filter((f) => f.event === 'subscribe');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.data).toEqual({ conversationId: '11111111-1111-1111-1111-111111111111' });

    sock.subscribe('22222222-2222-2222-2222-222222222222'); // after auth — sent immediately
    expect(parsed(last()).filter((f) => f.event === 'subscribe')).toHaveLength(2);
    sock.close();
  });

  it('forwards `message` frames to onMessage', async () => {
    const got: IncomingMessage[] = [];
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: (m) => got.push(m),
      WebSocketImpl: Impl,
    });
    last().open();
    await flush();
    last().deliver({ event: 'ready', data: {} });

    const message = {
      id: 'm1',
      senderUserId: 'bob',
      clientMessageId: 'c1',
      ciphertext: 'AAAA',
      alg: 'MLS_1.0',
      epoch: 0,
      attachmentObjectKey: null,
      createdAt: 't',
    };
    last().deliver({ event: 'message', data: { conversationId: 'conv-1', message } });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ conversationId: 'conv-1', message });
    sock.close();
  });

  it('fires onSubscribed with the conversationId on a `subscribed` ack (the catch-up trigger)', async () => {
    const onSubscribed = vi.fn();
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: () => {},
      onSubscribed,
      WebSocketImpl: Impl,
    });
    last().open();
    await flush();
    last().deliver({ event: 'ready', data: {} });

    last().deliver({ event: 'subscribed', data: { conversationId: 'conv-9' } });
    expect(onSubscribed).toHaveBeenCalledWith('conv-9'); // catch-up fires only AFTER the room-join ack
    sock.close();
  });

  it('reconnects after a drop: re-authenticates, re-subscribes, and fires onReady again', async () => {
    const onReady = vi.fn();
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: () => {},
      onReady,
      WebSocketImpl: Impl,
      reconnect: { baseMs: 1, maxMs: 5 },
    });
    sock.subscribe('33333333-3333-3333-3333-333333333333');
    last().open();
    await flush();
    last().deliver({ event: 'ready', data: {} });
    expect(FakeWebSocket.instances).toHaveLength(1);

    last().close(); // drop
    await waitFor(() => FakeWebSocket.instances.length >= 2); // wait for the backoff to reconnect (load-robust)
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    last().open();
    await flush();
    expect(parsed(last())[0]).toEqual({ event: 'auth', data: { token: 't' } }); // re-auth on the new socket
    last().deliver({ event: 'ready', data: {} });
    expect(onReady).toHaveBeenCalledTimes(2); // connection signal fires on every (re)connect
    expect(parsed(last()).some((f) => f.event === 'subscribe')).toBe(true); // re-subscribed
    sock.close();
  });

  it('reports safe connection status transitions without exposing transport details', async () => {
    const statuses: MessageSocketStatus[] = [];
    const sock = createMessageSocket({
      url: 'wss://host/ws?token=never-report',
      token: async () => 'secret-token',
      onMessage: () => {},
      onStatus: (status) => statuses.push(status),
      WebSocketImpl: Impl,
      reconnect: { baseMs: 1, maxMs: 5 },
    });

    expect(statuses).toEqual(['connecting']);
    last().open();
    await flush();
    last().deliver({ event: 'ready', data: {} });
    expect(statuses).toContain('connected');

    last().close();
    expect(statuses).toContain('reconnecting');
    expect(statuses.join(' ')).not.toContain('secret-token');
    expect(statuses.join(' ')).not.toContain('never-report');
    sock.close();
  });

  it('fires onWelcome for a post-auth welcome nudge and ignores a pre-auth one', async () => {
    const onWelcome = vi.fn();
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: () => {},
      onWelcome,
      WebSocketImpl: Impl,
    });
    last().open();
    await flush();

    // Pre-auth (before `ready`): the frame must be ignored — same defence in depth as 'message'.
    last().deliver({
      event: 'welcome',
      data: { conversationId: 'c0000000-0000-4000-a000-000000000001' },
    });
    expect(onWelcome).not.toHaveBeenCalled();

    last().deliver({ event: 'ready', data: {} });
    last().deliver({
      event: 'welcome',
      data: { conversationId: 'c0000000-0000-4000-a000-000000000001' },
    });
    expect(onWelcome).toHaveBeenCalledTimes(1);
    expect(onWelcome).toHaveBeenCalledWith('c0000000-0000-4000-a000-000000000001');

    // A malformed nudge (no conversationId) is dropped, not surfaced.
    last().deliver({ event: 'welcome', data: {} });
    expect(onWelcome).toHaveBeenCalledTimes(1);
    sock.close();
  });

  describe('defaultWsUrl', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('derives the WS origin from VITE_API_URL for a split deployment (ws(s) scheme + /ws)', () => {
      vi.stubEnv('VITE_API_URL', 'https://api.example.com');
      expect(defaultWsUrl()).toBe('wss://api.example.com/ws');
      vi.stubEnv('VITE_API_URL', 'http://localhost:3000/'); // trailing slash trimmed; http → ws
      expect(defaultWsUrl()).toBe('ws://localhost:3000/ws');
    });

    it('prefers an explicit VITE_WS_URL override', () => {
      vi.stubEnv('VITE_WS_URL', 'wss://realtime.example.com/socket');
      vi.stubEnv('VITE_API_URL', 'https://api.example.com');
      expect(defaultWsUrl()).toBe('wss://realtime.example.com/socket');
    });
  });

  it('close() stops reconnection', async () => {
    const sock = createMessageSocket({
      url: 'wss://host/ws',
      token: async () => 't',
      onMessage: () => {},
      WebSocketImpl: Impl,
      reconnect: { baseMs: 1, maxMs: 5 },
    });
    last().open();
    await flush();
    sock.close();
    const count = FakeWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeWebSocket.instances).toHaveLength(count); // no new socket after close()
  });
});
