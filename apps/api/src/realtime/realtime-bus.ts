import { z } from 'zod';

import type { FetchedMessage } from '../messaging/messaging.service.js';

/** A newly-stored message, ready to fan out to subscribed sockets. CIPHERTEXT ONLY (FetchedMessage). */
export interface MessageCreatedEvent {
  tenantId: string;
  conversationId: string;
  message: FetchedMessage;
}

// Validates a MessageCreatedEvent decoded from the Redis backplane before fan-out (defensive — a
// malformed/poisoned payload must not crash the gateway). `ciphertext` stays an opaque string (the
// server never parses it).
export const MessageCreatedEventSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  message: z.object({
    id: z.string().uuid(),
    senderUserId: z.string().uuid(),
    clientMessageId: z.string().uuid(),
    ciphertext: z.string(),
    alg: z.string(),
    epoch: z.number().int().nonnegative(),
    attachmentObjectKey: z.string().nullable(),
    createdAt: z.string(),
  }),
});

/**
 * A Welcome was delivered to a user — nudges the recipient's connected sockets to drain pending
 * Welcomes NOW instead of at the next reconnect (without it, a freshly-started conversation is
 * invisible to an already-connected peer until they refresh). METADATA ONLY: ids + the recipient's
 * verified subject — never the sealed Welcome/RatchetTree blobs (those ride the proof-gated REST fetch).
 */
export interface WelcomeCreatedEvent {
  tenantId: string;
  conversationId: string;
  /** The recipient's external subject (`users.external_identity_id`) — what an authed socket knows. */
  recipientSub: string;
}

// Validates a WelcomeCreatedEvent decoded from the Redis backplane (same defensive posture as messages).
export const WelcomeCreatedEventSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  recipientSub: z.string().min(1),
});

/**
 * A member advanced their delivered/read HIGH-WATER-MARK in a conversation (checkpoint 31). Fanned out to
 * the conversation room so the OTHER members' connected sockets flip their delivery ticks live (without it,
 * a sender only learns the peer received/read on their next refetch). METADATA ONLY: the member id + a
 * "through message id" + the status — never content or keys (invariant #2).
 */
export interface ReceiptAdvancedEvent {
  tenantId: string;
  conversationId: string;
  /** The member who advanced their watermark (the VERIFIED caller of POST …/receipts). */
  userId: string;
  status: 'delivered' | 'read';
  /** The message the member has received/read THROUGH (earlier implied). */
  throughMessageId: string;
}

// Validates a ReceiptAdvancedEvent decoded from the Redis backplane (same defensive posture as the others).
export const ReceiptAdvancedEventSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
  status: z.enum(['delivered', 'read']),
  throughMessageId: z.string().uuid(),
});

/**
 * A commit was accepted (epoch slot won). Nudges all conversation members' connected sockets to drain
 * the new commit NOW via `GET /commits?afterEpoch=N`. OPAQUE COMMIT BYTES ARE NOT INCLUDED — only the
 * routing metadata (ids + epoch). Clients fetch the frame via REST; the WS event is a push-notification
 * only. This keeps the realtime bus at invariant #2 (IDs and metadata only, never ciphertext over the
 * bus directly — the DB is the authoritative store).
 *
 * Note: unlike messages, commits are NOT included in the WS payload — clients must drain via REST to
 * process them in epoch order. The event signals "there is a new commit you need to fetch".
 */
export interface CommitCreatedEvent {
  tenantId: string;
  conversationId: string;
  epoch: number;
  senderUserId: string | null;
  commitId: string;
  createdAt: string;
}

export const CommitCreatedEventSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  senderUserId: z.string().uuid().nullable(),
  commitId: z.string().uuid(),
  createdAt: z.string(),
});

/**
 * A commit removed one or more members — signals their connected sockets to leave the room.
 * METADATA ONLY: the verified subs of the removed members (so the gateway can evict by (tenant, sub)
 * without touching message content). Never carries conversation content or keys (invariant #2).
 */
export interface MemberRemovedEvent {
  tenantId: string;
  conversationId: string;
  /** External identity subjects (`users.external_identity_id`) of the removed members. */
  removedSubs: string[];
}

export const MemberRemovedEventSchema = z.object({
  tenantId: z.string().min(1),
  conversationId: z.string().uuid(),
  removedSubs: z.array(z.string().min(1)),
});

/**
 * D2 has registered a pending enrollment and is waiting for D1 to approve. Nudges D1's connected
 * sockets to show the approval UI. METADATA ONLY: ids + the user's verified subject — never key
 * material or the fingerprint bytes (those come from REST GET /devices/enrollments). Invariant #2.
 */
export interface DeviceEnrollmentPendingEvent {
  tenantId: string;
  enrollmentId: string;
  /** The user's external subject — D1's connected sockets filter on (tenant, userSub). */
  userSub: string;
  /** D2's device id — clients use this to skip the event on D2 itself (only D1 should see the prompt). */
  requestingDeviceId: string;
}

export const DeviceEnrollmentPendingEventSchema = z.object({
  tenantId: z.string().min(1),
  enrollmentId: z.string().uuid(),
  userSub: z.string().min(1),
  requestingDeviceId: z.string().uuid(),
});

/**
 * D1 approved D2's enrollment — nudges D2's connected sockets to drain Welcomes now. Metadata only.
 * D2 identifies itself by (tenant, userSub) — D1 and D2 share the same OIDC subject.
 */
export interface DeviceEnrollmentApprovedEvent {
  tenantId: string;
  enrollmentId: string;
  /** The user's external subject — D2's connected sockets filter on (tenant, userSub). */
  userSub: string;
}

export const DeviceEnrollmentApprovedEventSchema = z.object({
  tenantId: z.string().min(1),
  enrollmentId: z.string().uuid(),
  userSub: z.string().min(1),
});

/**
 * A friend request was created and stored — nudges the recipient's connected sockets to refresh
 * their incoming-requests list NOW instead of waiting for a manual open/reload. METADATA ONLY:
 * the recipient's verified subject only — no sender info, no argus-ids, no content (invariant #2).
 */
export interface FriendRequestCreatedEvent {
  tenantId: string;
  /** The recipient's external subject (`users.external_identity_id`) — what an authed socket knows. */
  recipientSub: string;
}

export const FriendRequestCreatedEventSchema = z.object({
  tenantId: z.string().min(1),
  recipientSub: z.string().min(1),
});

/**
 * The callee's device receives a ring frame when a gate-passing invite is processed. METADATA ONLY:
 * the caller's DB id + the shared conversation id — never SDP, keys, or content (invariant #2).
 * Routes by identity (tenantId, calleeSub) → callee's connected socket(s).
 */
export interface CallRingEvent {
  tenantId: string;
  callId: string;
  conversationId: string;
  /** Caller's internal user UUID — callee uses this to resolve the caller's display name. */
  callerUserId: string;
  /** Callee's external identity subject (`users.external_identity_id`) for socket routing. */
  calleeSub: string;
  media: 'audio';
}

export const CallRingEventSchema = z
  .object({
    tenantId: z.string().min(1),
    callId: z.string().uuid(),
    conversationId: z.string().uuid(),
    callerUserId: z.string().uuid(),
    calleeSub: z.string().min(1),
    media: z.literal('audio'),
  })
  .strict();

/**
 * A peer-to-peer signaling frame relayed through the gateway. The `envelope.ciphertext` is an
 * opaque MLS blob — the server forwards it verbatim and never parses it (invariant #1). `alg` and
 * `epoch` are wire-protocol metadata the receiver needs to select the right group key; the server
 * does not interpret them. Routed by (tenantId, peerSub) identity — delivered only to the
 * registered peer's sockets, not to the conversation room.
 */
export interface CallSignalEvent {
  tenantId: string;
  callId: string;
  conversationId: string;
  /** Sender's client-scoped sequence number — passed through verbatim for the receiver's ordering. */
  msgSeq: number;
  /** Sender's external identity subject. */
  senderSub: string;
  /** Sender's verified DB UUID — used to attribute the frame per CallSignalFrameSchema. */
  senderUserId: string;
  /** Peer's external identity subject — the delivery target (routing is by identity, not room). */
  peerSub: string;
  /** Gateway-minted monotonic counter — lets the receiver detect out-of-order delivery. */
  deliverySeq: number;
  /** MLS envelope forwarded verbatim — ciphertext is opaque; alg/epoch are wire metadata only. */
  envelope: { ciphertext: string; alg: string; epoch: number };
}

export const CallSignalEventSchema = z
  .object({
    tenantId: z.string().min(1),
    callId: z.string().uuid(),
    conversationId: z.string().uuid(),
    msgSeq: z.number().int().nonnegative(),
    senderSub: z.string().min(1),
    senderUserId: z.string(),
    peerSub: z.string().min(1),
    deliverySeq: z.number().int(),
    envelope: z
      .object({
        ciphertext: z.string().min(1),
        alg: z.string().min(1),
        epoch: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * A server-issued end-of-call notification for server-known lifecycle events only (ring timeout,
 * abrupt peer disconnect). Client-initiated decline/busy/cancel/hangup travel inside the encrypted
 * `call.signal` — the server never learns the call phase from those. Delivered by identity
 * (callerSub + calleeSub) rather than room fan-out, so participants who are online but not
 * subscribed to the conversation room (the common state during ringing) still receive the event.
 */
export interface CallEndEvent {
  tenantId: string;
  callId: string;
  conversationId: string;
  reason: 'timeout' | 'peer-gone';
  /** Caller's socket-auth subject — used for identity-routed delivery. */
  callerSub: string;
  /** Callee's canonical socket-auth subject — used for identity-routed delivery. */
  calleeSub: string;
}

export const CallEndEventSchema = z
  .object({
    tenantId: z.string().min(1),
    callId: z.string().uuid(),
    conversationId: z.string().uuid(),
    reason: z.enum(['timeout', 'peer-gone']),
    callerSub: z.string().min(1),
    calleeSub: z.string().min(1),
  })
  .strict();

/**
 * Realtime fan-out bus — decouples the HTTP send path (publisher) from the WebSocket gateway
 * (subscriber). Abstract so it can be in-process (single-pod / dev / tests) or Redis-backed for
 * cross-pod delivery (checkpoint 29). Only the opaque ciphertext envelope ever crosses it.
 */
export abstract class RealtimeBus {
  abstract emitMessageCreated(event: MessageCreatedEvent): void;
  abstract onMessageCreated(listener: (event: MessageCreatedEvent) => void): void;
  abstract emitWelcomeCreated(event: WelcomeCreatedEvent): void;
  abstract onWelcomeCreated(listener: (event: WelcomeCreatedEvent) => void): void;
  abstract emitReceiptAdvanced(event: ReceiptAdvancedEvent): void;
  abstract onReceiptAdvanced(listener: (event: ReceiptAdvancedEvent) => void): void;
  abstract emitCommitCreated(event: CommitCreatedEvent): void;
  abstract onCommitCreated(listener: (event: CommitCreatedEvent) => void): void;
  abstract emitMemberRemoved(event: MemberRemovedEvent): void;
  abstract onMemberRemoved(listener: (event: MemberRemovedEvent) => void): void;
  abstract emitDeviceEnrollmentPending(event: DeviceEnrollmentPendingEvent): void;
  abstract onDeviceEnrollmentPending(listener: (event: DeviceEnrollmentPendingEvent) => void): void;
  abstract emitDeviceEnrollmentApproved(event: DeviceEnrollmentApprovedEvent): void;
  abstract onDeviceEnrollmentApproved(
    listener: (event: DeviceEnrollmentApprovedEvent) => void,
  ): void;
  abstract emitFriendRequestCreated(event: FriendRequestCreatedEvent): void;
  abstract onFriendRequestCreated(listener: (event: FriendRequestCreatedEvent) => void): void;
  // ── VoIP signaling ──
  abstract emitCallRing(event: CallRingEvent): void;
  abstract onCallRing(listener: (event: CallRingEvent) => void): void;
  abstract emitCallSignal(event: CallSignalEvent): void;
  abstract onCallSignal(listener: (event: CallSignalEvent) => void): void;
  abstract emitCallEnd(event: CallEndEvent): void;
  abstract onCallEnd(listener: (event: CallEndEvent) => void): void;
}
