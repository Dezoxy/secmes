import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';

import { AuthService, type MaybeUnboundAuth, type VerifiedAuth } from '../auth/auth.service.js';
import { CallsAuthzService } from '../calls/calls-authz.service.js';
import { CallEnvelopeSchema, CallIdSchema } from '../calls/calls.schemas.js';
import { wsConnectionsActive } from '../observability/metrics.js';
import { MessagingService } from '../messaging/messaging.service.js';
import {
  RealtimeBus,
  type CallEndEvent,
  type CallRingEvent,
  type CallSignalEvent,
  type CommitCreatedEvent,
  type DeviceEnrollmentApprovedEvent,
  type DeviceEnrollmentPendingEvent,
  type FriendRequestCreatedEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
  type ReceiptAdvancedEvent,
  type WelcomeCreatedEvent,
} from './realtime-bus.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_DEADLINE_MS = 10_000; // close a socket that doesn't authenticate (first frame) in time

// Per-socket subscribe-frame rate limit. Each NEW-room `subscribe` triggers a `messaging.isMember` DB
// lookup, so an authenticated socket spamming distinct UUIDs could hammer the DB — the WS analogue of the
// HTTP abuse caps (the HTTP throttler can't see `ws` frames). 120/window is far above any real reconnect
// burst (the client re-subscribes only its tracked conversations) yet bounds the lookups one socket can
// force. Per-user-aggregate + connection-count caps remain the edge's job (Caddy/WAF) — see rate-limiting.md.
const SUBSCRIBE_WINDOW_MS = 60_000;
const SUBSCRIBE_MAX_PER_WINDOW = 120;

// Per-socket call-signal rate limit. Separate from the subscribe counter: call frames are higher
// frequency (one per ICE candidate burst) and don't trigger DB lookups, so the cap is higher.
// A signaling burst of 300/min is ~5/s sustained — well above any real ICE trickle yet bounds abuse.
const CALL_SIGNAL_WINDOW_MS = 60_000;
const CALL_SIGNAL_MAX_PER_WINDOW = 300;

/** Per-socket state. A socket does nothing until it has authenticated. */
interface ConnState {
  connId: string; // per-connection random UUID for structured log correlation
  authed: boolean;
  auth?: VerifiedAuth;
  subs: Set<string>; // room keys this socket joined
  authTimer?: ReturnType<typeof setTimeout>;
  subWindowStart: number; // ms; start of the current subscribe-rate window
  subCount: number; // new-room subscribe frames counted in the current window
  // Per-(socket, room) TRANSPORT delivery counter: the seq of the last `message` frame fanned out to THIS
  // socket for that room (1-based; absent room ⇒ 0 ⇒ next frame is seq 1). Lets the client detect a
  // dropped/reordered frame and self-heal via the existing backfill. EPHEMERAL (lives only for the socket
  // lifetime, dropped with the state on disconnect); never persisted; NOT the MLS epoch/generation; carries
  // no cryptographic guarantee. See @argus/contracts MessageEventSchema.
  outSeq: Map<string, number>;
  // Per-socket call-signal rate limit (separate from subscribe — different cap, no DB lookup).
  callWindowStart: number;
  callCount: number;
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
  private deliverySeqCounter = 0; // monotonic counter for CallSignalFrameSchema.deliverySeq

  constructor(
    @InjectPinoLogger(RealtimeGateway.name) private readonly logger: PinoLogger,
    private readonly auth: AuthService,
    private readonly messaging: MessagingService,
    private readonly bus: RealtimeBus,
    private readonly callsAuthz: CallsAuthzService,
  ) {}

  onModuleInit(): void {
    this.bus.onMessageCreated((event) => this.deliver(event));
    this.bus.onWelcomeCreated((event) => this.notifyWelcome(event));
    this.bus.onReceiptAdvanced((event) => this.deliverReceipt(event));
    this.bus.onCommitCreated((event) => this.deliverCommit(event));
    this.bus.onMemberRemoved((event) => this.notifyRemoved(event));
    this.bus.onDeviceEnrollmentPending((event) => this.notifyEnrollmentPending(event));
    this.bus.onDeviceEnrollmentApproved((event) => this.notifyEnrollmentApproved(event));
    this.bus.onFriendRequestCreated((event) => this.notifyFriendRequest(event));
    this.bus.onCallRing((event) => this.deliverCallRing(event));
    this.bus.onCallSignal((event) => this.relayCallSignal(event));
    this.bus.onCallEnd((event) => this.deliverCallEnd(event));
  }

  handleConnection(client: WebSocket): void {
    const state: ConnState = {
      connId: randomUUID(),
      authed: false,
      subs: new Set(),
      subWindowStart: Date.now(),
      subCount: 0,
      outSeq: new Map(),
      callWindowStart: Date.now(),
      callCount: 0,
    };
    // Close sockets that connect but never authenticate (resource exhaustion / probing).
    state.authTimer = setTimeout(() => {
      if (!state.authed) {
        this.logger.warn({ connId: state.connId }, 'ws:auth_timeout');
        client.close(4408, 'auth timeout');
      }
    }, AUTH_DEADLINE_MS);
    this.conns.set(client, state);
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.conns.get(client);
    if (!state) return;
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.authed) wsConnectionsActive.dec();
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
    let auth: MaybeUnboundAuth;
    try {
      auth = await this.auth.verify(token); // throws on any failure; never logged
    } catch {
      this.logger.warn({ connId: state.connId, reason: 'invalid_token' }, 'ws:auth_failed');
      client.close(4401, 'unauthorized');
      return;
    }
    // Unbound users have no tenant — they cannot subscribe to any conversation room.
    if (auth.tenantId === null) {
      client.close(4403, 'not bound to a tenant');
      return;
    }
    state.authed = true;
    state.auth = auth as VerifiedAuth;
    if (state.authTimer) clearTimeout(state.authTimer);
    wsConnectionsActive.inc();
    this.logger.info({ connId: state.connId, sub: auth.sub, tenantId: auth.tenantId }, 'ws:auth');
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
      this.logger.warn({ connId: state.connId, sub: state.auth.sub }, 'ws:subscribe_rate_limited');
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
    this.logger.info({ connId: state.connId, conversationId }, 'ws:subscribe');
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
    const room = roomKey(event.tenantId, event.conversationId);
    const sockets = this.rooms.get(room);
    if (!sockets) return;
    // Include conversationId in the frame: one socket multiplexes many conversations, so the client
    // needs to know which conversation each delivered message belongs to. Each socket also gets its OWN
    // per-room transport delivery counter (deliverySeq), stamped only on the frames it actually receives,
    // so it can spot a dropped/reordered frame (deliverySeq != deliveryPrevSeq + 1) and re-fetch. The
    // counter is metadata only — the message stays the opaque ciphertext envelope (invariant #1).
    for (const client of sockets) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = this.conns.get(client);
      if (!state) continue; // socket disconnected between the room set and here; skip (no counter burn)
      const prev = state.outSeq.get(room) ?? 0;
      const seq = prev + 1;
      state.outSeq.set(room, seq);
      this.send(client, 'message', {
        conversationId: event.conversationId,
        message: event.message,
        deliverySeq: seq,
        deliveryPrevSeq: prev === 0 ? null : prev,
      });
    }
  }

  /**
   * Nudge the recipient's connected sockets that a Welcome is waiting: the client reacts by draining its
   * pending Welcomes (join) — without this, a freshly-started conversation stays invisible to an
   * already-connected peer until their next reconnect. Matched on the socket's VERIFIED (tenant, sub) —
   * never client input — and unlike `deliver` it needs no room: the recipient can't be subscribed to a
   * conversation it hasn't joined yet. Frame carries the conversationId only (ids/metadata, invariant #2);
   * the sealed join material still rides the proof-gated REST fetch.
   */
  /**
   * Fan a watermark advance out to the conversation room so the OTHER members' sockets flip their delivery
   * ticks live. Same room-scoped authz as `deliver` (only subscribed members of this tenant+conversation
   * receive it) — a receipt never crosses a tenant or reaches a non-member. METADATA ONLY (ids + status):
   * the member who acked, and the message they acked through. The actor's own sockets get the echo too
   * (harmless — the client fold is monotonic).
   */
  private deliverReceipt(event: ReceiptAdvancedEvent): void {
    const sockets = this.rooms.get(roomKey(event.tenantId, event.conversationId));
    if (!sockets) return;
    const data = {
      conversationId: event.conversationId,
      userId: event.userId,
      status: event.status,
      throughMessageId: event.throughMessageId,
    };
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) this.send(client, 'receipt', data);
    }
  }

  /** Notify all subscribed sockets in the conversation room that a new commit is available to drain. */
  private deliverCommit(event: CommitCreatedEvent): void {
    const sockets = this.rooms.get(roomKey(event.tenantId, event.conversationId));
    if (!sockets) return;
    const data = {
      conversationId: event.conversationId,
      epoch: event.epoch,
      senderUserId: event.senderUserId,
      commitId: event.commitId,
      createdAt: event.createdAt,
    };
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) this.send(client, 'commit', data);
    }
  }

  private notifyWelcome(event: WelcomeCreatedEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.recipientSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'welcome', { conversationId: event.conversationId });
      }
    }
  }

  /**
   * Evict sockets belonging to removed members from the conversation room and push a 'removed' frame
   * so the client can immediately leave the conversation UI. Matched on (tenant, sub) — never by an
   * unverified client id — so a removed member's in-flight sockets stop receiving room traffic as soon
   * as the commit lands. METADATA ONLY (ids, invariant #2).
   */
  private notifyRemoved(event: MemberRemovedEvent): void {
    const room = roomKey(event.tenantId, event.conversationId);
    const removedSubSet = new Set(event.removedSubs);
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId) continue;
      if (!removedSubSet.has(state.auth.sub)) continue;
      // Notify before evicting so the client receives the frame before the socket unsubscribes.
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'removed', { conversationId: event.conversationId });
      }
      state.subs.delete(room);
      state.outSeq.delete(room); // reset the transport counter so a later re-subscribe restarts at seq 1
      this.rooms.get(room)?.delete(client);
    }
    const sockets = this.rooms.get(room);
    if (sockets && sockets.size === 0) this.rooms.delete(room);
  }

  private notifyEnrollmentPending(event: DeviceEnrollmentPendingEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.userSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'enrollment_pending', {
          enrollmentId: event.enrollmentId,
          requestingDeviceId: event.requestingDeviceId,
        });
      }
    }
  }

  private notifyEnrollmentApproved(event: DeviceEnrollmentApprovedEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.userSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'enrollment_approved', { enrollmentId: event.enrollmentId });
      }
    }
  }

  private notifyFriendRequest(event: FriendRequestCreatedEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.recipientSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'friend_request', {});
      }
    }
  }

  /**
   * Inbound relay frame: client sends an encrypted `CallSignal` that the gateway forwards opaquely
   * to the peer (invariant #1 — the server never parses the inner signal). Every signal type (offer,
   * answer, ICE, hang-up) is an encrypted inner discriminant; the gateway only sees the routing
   * envelope. Authorization is checked at three levels: membership, callId in the live authz map,
   * and sender being one of the two registered participants. Any failure → silent drop (no oracle).
   */
  @SubscribeMessage('call.signal')
  async onCallSignal(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() data: unknown,
  ): Promise<void> {
    const state = this.conns.get(client);
    if (!state?.authed || !state.auth) return; // unauthenticated — silent return, not close
    if (!state.auth.userId) return; // missing DB UUID — can't attribute sender; silent drop
    if (!this.allowCallSignal(state)) {
      this.send(client, 'error', { message: 'rate limited' });
      return;
    }
    // Parse failure → silent drop (prevents shape oracle; a malformed frame reveals nothing useful).
    const parsed = CallEnvelopeSchema.safeParse(data);
    if (!parsed.success) return;
    const { conversationId, callId, envelope, msgSeq } = parsed.data;
    // callId authz — must be in the live map AND sender must be a registered participant.
    // Membership is already established: the authz entry only exists because both participants
    // passed the membership + direct-conversation gate at invite time. No per-frame DB lookup.
    const entry = this.callsAuthz.validateAndRelay(callId, state.auth.sub, state.auth.tenantId);
    if (!entry) return; // unknown/expired/non-participant — silent drop
    // Guard: client-supplied conversationId must match the invite-registered value. A participant
    // in two conversations could otherwise inject a mismatched conversationId into the peer's frame.
    if (conversationId !== entry.conversationId) return;
    // Emit onto the bus. Fire-and-forget: best-effort relay, no ack (the call fails if it drops).
    // alg/epoch are wire-protocol metadata (not content); forwarded so the peer can decrypt.
    this.bus.emitCallSignal({
      tenantId: state.auth.tenantId,
      callId,
      conversationId: entry.conversationId, // authoritative — from the invite, not the client frame
      msgSeq,
      senderSub: state.auth.sub,
      senderUserId: state.auth.userId,
      peerSub: entry.callerSub === state.auth.sub ? entry.calleeSub : entry.callerSub,
      deliverySeq: ++this.deliverySeqCounter,
      envelope: { ciphertext: envelope.ciphertext, alg: envelope.alg, epoch: envelope.epoch },
    });
  }

  /**
   * Minimal server-state cleanup frame: lets the client promptly release the call-authorization
   * entry on hang-up/decline so the server doesn't have to wait for the inactivity timeout. Carries
   * only `{callId}` — no reason, no SDP. Always triggers a server-issued `call.end{peer-gone}` to
   * both participants (inside `callsAuthz.release`) so a callee who received `call.ring` can dismiss
   * the incoming-call UI even if the encrypted cancel signal was dropped. Idempotent (no-op if
   * already gone).
   */
  @SubscribeMessage('call.release')
  onCallRelease(@ConnectedSocket() client: WebSocket, @MessageBody() data: unknown): void {
    const state = this.conns.get(client);
    if (!state?.authed || !state.auth) return;
    if (!this.allowCallSignal(state)) return; // rate limit — silent drop (release is best-effort)
    const callId = (data as { callId?: unknown } | null)?.callId;
    const parsed = CallIdSchema.safeParse(callId);
    if (!parsed.success) return; // invalid UUID — silent drop
    // call.end{peer-gone} is emitted inside callsAuthz.release() for both participants.
    this.callsAuthz.release(parsed.data, state.auth.sub, state.auth.tenantId);
  }

  /** Fixed-window rate check for call signal frames on one socket (same pattern as allowSubscribe). */
  private allowCallSignal(state: ConnState): boolean {
    const now = Date.now();
    if (now - state.callWindowStart >= CALL_SIGNAL_WINDOW_MS) {
      state.callWindowStart = now;
      state.callCount = 0;
    }
    state.callCount += 1;
    return state.callCount <= CALL_SIGNAL_MAX_PER_WINDOW;
  }

  /**
   * Ring the callee's connected socket(s) — the call invite was gate-passing, so this is the real
   * ring. Routed by (tenantId, calleeSub) on the VERIFIED socket binding, same as notifyWelcome.
   * The frame carries only metadata (callId, conversationId, callerUserId, media) — no SDP, no keys.
   */
  private deliverCallRing(event: CallRingEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.calleeSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'call.ring', {
          callId: event.callId,
          conversationId: event.conversationId,
          callerUserId: event.callerUserId,
          media: event.media,
        });
      }
    }
  }

  /**
   * Deliver the opaque signal envelope to the peer's connected sockets. Routed by (tenantId,
   * peerSub) identity — same pattern as deliverCallRing — so a group-conversation callId cannot
   * fan signals to non-participants. The envelope is forwarded verbatim (invariant #1).
   */
  private relayCallSignal(event: CallSignalEvent): void {
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId || state.auth.sub !== event.peerSub) continue;
      if (client.readyState === WebSocket.OPEN) {
        this.send(client, 'call.signal', {
          callId: event.callId,
          conversationId: event.conversationId,
          msgSeq: event.msgSeq,
          senderUserId: event.senderUserId,
          deliverySeq: event.deliverySeq,
          envelope: event.envelope, // full { ciphertext, alg, epoch } — forwarded verbatim
        });
      }
    }
  }

  /**
   * Server-issued end-of-call notification for server-known lifecycle events (ring timeout,
   * prolonged inactivity). Routed by identity (callerSub + calleeSub) rather than room fan-out
   * so participants who are online but not subscribed to the conversation room — the common state
   * during ringing — still receive the event.
   */
  private deliverCallEnd(event: CallEndEvent): void {
    const data = {
      callId: event.callId,
      conversationId: event.conversationId,
      reason: event.reason,
    };
    for (const [client, state] of this.conns) {
      if (!state.authed || !state.auth) continue;
      if (state.auth.tenantId !== event.tenantId) continue;
      if (state.auth.sub !== event.callerSub && state.auth.sub !== event.calleeSub) continue;
      if (client.readyState === WebSocket.OPEN) this.send(client, 'call.end', data);
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
