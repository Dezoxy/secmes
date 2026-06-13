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
}
