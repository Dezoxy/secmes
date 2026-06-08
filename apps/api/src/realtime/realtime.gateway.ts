import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';

import { AuthService, type VerifiedAuth } from '../auth/auth.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeBus, type MessageCreatedEvent } from './realtime-bus.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_DEADLINE_MS = 10_000; // close a socket that doesn't authenticate (first frame) in time

// Per-socket subscribe-frame rate limit. Each NEW-room `subscribe` triggers a `messaging.isMember` DB
// lookup, so an authenticated socket spamming distinct UUIDs could hammer the DB — the WS analogue of the
// HTTP abuse caps (the HTTP throttler can't see `ws` frames). 120/window is far above any real reconnect
// burst (the client re-subscribes only its tracked conversations) yet bounds the lookups one socket can
// force. Per-user-aggregate + connection-count caps remain the edge's job (Caddy/WAF) — see rate-limiting.md.
const SUBSCRIBE_WINDOW_MS = 60_000;
const SUBSCRIBE_MAX_PER_WINDOW = 120;

/** Per-socket state. A socket does nothing until it has authenticated. */
interface ConnState {
  authed: boolean;
  auth?: VerifiedAuth;
  subs: Set<string>; // room keys this socket joined
  authTimer?: ReturnType<typeof setTimeout>;
  subWindowStart: number; // ms; start of the current subscribe-rate window
  subCount: number; // new-room subscribe frames counted in the current window
}

const roomKey = (tenantId: string, conversationId: string): string =>
  `${tenantId}:${conversationId}`;

/**
 * WebSocket gateway for real-time delivery of CIPHERTEXT envelopes (checkpoint 28). A socket must
 * authenticate with a first-frame token before it can subscribe, and may only subscribe to conversations
 * it is a member of. Delivery is keyed by (tenant, conversation), so a fan-out never crosses a tenant or
 * reaches a non-member. The gateway never decrypts — it forwards opaque ciphertext only.
 */
@Injectable()
@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly conns = new Map<WebSocket, ConnState>();
  private readonly rooms = new Map<string, Set<WebSocket>>(); // roomKey → subscribed sockets

  constructor(
    private readonly auth: AuthService,
    private readonly messaging: MessagingService,
    private readonly bus: RealtimeBus,
  ) {}

  onModuleInit(): void {
    this.bus.onMessageCreated((event) => this.deliver(event));
  }

  handleConnection(client: WebSocket): void {
    const state: ConnState = {
      authed: false,
      subs: new Set(),
      subWindowStart: Date.now(),
      subCount: 0,
    };
    // Close sockets that connect but never authenticate (resource exhaustion / probing).
    state.authTimer = setTimeout(() => {
      if (!state.authed) client.close(4408, 'auth timeout');
    }, AUTH_DEADLINE_MS);
    this.conns.set(client, state);
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.conns.get(client);
    if (!state) return;
    if (state.authTimer) clearTimeout(state.authTimer);
    for (const room of state.subs) {
      const sockets = this.rooms.get(room);
      sockets?.delete(client);
      if (sockets && sockets.size === 0) this.rooms.delete(room); // reclaim emptied rooms (no leak)
    }
    this.conns.delete(client);
  }

  /** First frame: verify the bearer token and bind {sub, tenantId} to the socket. */
  @SubscribeMessage('auth')
  async onAuth(@ConnectedSocket() client: WebSocket, @MessageBody() data: unknown): Promise<void> {
    const state = this.conns.get(client);
    if (!state || state.authed) return; // unknown socket, or already authed (ignore re-auth)
    const token = (data as { token?: unknown } | null)?.token;
    if (typeof token !== 'string') {
      client.close(4400, 'auth requires a token');
      return;
    }
    let auth: VerifiedAuth;
    try {
      auth = await this.auth.verify(token); // throws on any failure; never logged
    } catch {
      client.close(4401, 'unauthorized');
      return;
    }
    state.authed = true;
    state.auth = auth;
    if (state.authTimer) clearTimeout(state.authTimer);
    this.send(client, 'ready', { sub: auth.sub });
  }

  /** Join a conversation's delivery room — only if the authenticated caller is a member. */
  @SubscribeMessage('subscribe')
  async onSubscribe(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: unknown,
  ): Promise<void> {
    const state = this.conns.get(client);
    if (!state?.authed || !state.auth) {
      client.close(4401, 'not authenticated');
      return;
    }
    const conversationId = (data as { conversationId?: unknown } | null)?.conversationId;
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
      this.send(client, 'error', { message: 'invalid conversationId' });
      return;
    }
    // Already in this room: ACK without a DB lookup. Makes repeated subscribes to the same conversation
    // idempotent + free, and ensures a reconnect-storm of already-tracked rooms can't hammer `isMember`.
    const room = roomKey(state.auth.tenantId, conversationId);
    if (state.subs.has(room)) {
      this.send(client, 'subscribed', { conversationId });
      return;
    }
    // Bound the NEW-room subscribe rate per socket — each one costs a DB lookup (see SUBSCRIBE_MAX_PER_WINDOW).
    if (!this.allowSubscribe(state)) {
      this.send(client, 'error', { message: 'rate limited' });
      return;
    }
    // Same authz as REST: must be a member. Don't distinguish non-member from non-existent.
    const isMember = await this.messaging.isMember(state.auth, conversationId);
    // The socket may have disconnected DURING the async lookup — handleDisconnect then already ran and
    // removed it from `conns`. Don't resurrect a dead connection into `rooms` (it would leak, since no
    // future disconnect would clean it up). Re-check the live state before joining.
    if (this.conns.get(client) !== state) return;
    if (!isMember) {
      this.send(client, 'error', { message: 'conversation not found' });
      return;
    }
    state.subs.add(room);
    let sockets = this.rooms.get(room);
    if (!sockets) {
      sockets = new Set();
      this.rooms.set(room, sockets);
    }
    sockets.add(client);
    this.send(client, 'subscribed', { conversationId });
  }

  /** Fixed-window rate check for new-room subscribes on one socket. Returns false once over the cap. */
  private allowSubscribe(state: ConnState): boolean {
    const now = Date.now();
    if (now - state.subWindowStart >= SUBSCRIBE_WINDOW_MS) {
      state.subWindowStart = now;
      state.subCount = 0;
    }
    state.subCount += 1;
    return state.subCount <= SUBSCRIBE_MAX_PER_WINDOW;
  }

  /** Fan a newly-stored message out to the subscribed sockets of its (tenant, conversation). */
  private deliver(event: MessageCreatedEvent): void {
    const sockets = this.rooms.get(roomKey(event.tenantId, event.conversationId));
    if (!sockets) return;
    // Include conversationId in the frame: one socket multiplexes many conversations, so the client
    // needs to know which conversation each delivered message belongs to.
    const data = { conversationId: event.conversationId, message: event.message };
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) this.send(client, 'message', data);
    }
  }

  private send(client: WebSocket, event: string, data: unknown): void {
    try {
      client.send(JSON.stringify({ event, data }));
    } catch {
      // The socket may have died between the readyState check and this write; `ws` throws on a dead
      // connection. Drop silently (handleDisconnect cleans it up) — a single dead client must NOT abort
      // fan-out to the rest of the room. Content-free catch (never surfaces ciphertext).
    }
  }
}
