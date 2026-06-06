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

/** Per-socket state. A socket does nothing until it has authenticated. */
interface ConnState {
  authed: boolean;
  auth?: VerifiedAuth;
  subs: Set<string>; // room keys this socket joined
  authTimer?: ReturnType<typeof setTimeout>;
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
    const state: ConnState = { authed: false, subs: new Set() };
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
    // Same authz as REST: must be a member. Don't distinguish non-member from non-existent.
    const isMember = await this.messaging.isMember(state.auth, conversationId);
    if (!isMember) {
      this.send(client, 'error', { message: 'conversation not found' });
      return;
    }
    const room = roomKey(state.auth.tenantId, conversationId);
    state.subs.add(room);
    let sockets = this.rooms.get(room);
    if (!sockets) {
      sockets = new Set();
      this.rooms.set(room, sockets);
    }
    sockets.add(client);
    this.send(client, 'subscribed', { conversationId });
  }

  /** Fan a newly-stored message out to the subscribed sockets of its (tenant, conversation). */
  private deliver(event: MessageCreatedEvent): void {
    const sockets = this.rooms.get(roomKey(event.tenantId, event.conversationId));
    if (!sockets) return;
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) this.send(client, 'message', event.message);
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
