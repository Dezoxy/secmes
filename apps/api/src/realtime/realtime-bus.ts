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
 * Realtime fan-out bus — decouples the HTTP send path (publisher) from the WebSocket gateway
 * (subscriber). Abstract so it can be in-process (single-pod / dev / tests) or Redis-backed for
 * cross-pod delivery (checkpoint 29). Only the opaque ciphertext envelope ever crosses it.
 */
export abstract class RealtimeBus {
  abstract emitMessageCreated(event: MessageCreatedEvent): void;
  abstract onMessageCreated(listener: (event: MessageCreatedEvent) => void): void;
}
