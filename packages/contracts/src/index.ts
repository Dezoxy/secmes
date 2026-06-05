import { z } from 'zod';

/**
 * The wire format shared by client and server.
 *
 * INVARIANT: the server treats `ciphertext` as opaque. It MUST NOT contain,
 * and the server MUST NOT log or attempt to interpret, any plaintext.
 * Only the fields below ever reach the backend in the clear — none of them
 * reveal message content.
 */

export const CipherEnvelopeSchema = z.object({
  /** MLS-protected ciphertext, base64. Opaque to the server. */
  ciphertext: z.string().min(1),
  /** AEAD algorithm tag, e.g. "MLS_1.0". Lets clients negotiate/version. */
  alg: z.string().min(1),
  /** Epoch/key identifiers so the recipient can select the right ratchet state. */
  epoch: z.number().int().nonnegative(),
});
export type CipherEnvelope = z.infer<typeof CipherEnvelopeSchema>;

export const SendMessageSchema = z.object({
  conversationId: z.string().uuid(),
  /** Client-generated id for idempotency + optimistic UI. */
  clientMessageId: z.string().uuid(),
  envelope: CipherEnvelopeSchema,
  /** Optional reference to an already-uploaded encrypted blob. */
  attachmentObjectKey: z.string().min(1).optional(),
});
export type SendMessage = z.infer<typeof SendMessageSchema>;

export const DeliveryStatus = z.enum(['sent', 'delivered', 'read', 'failed']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Health/version contract for the Phase 0 walking skeleton. */
export const ServiceInfoSchema = z.object({
  service: z.string(),
  version: z.string(),
  status: z.literal('ok'),
});
export type ServiceInfo = z.infer<typeof ServiceInfoSchema>;
