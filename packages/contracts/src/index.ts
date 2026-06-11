import { z } from 'zod';

/**
 * The wire format shared by client and server.
 *
 * INVARIANT: the server treats `ciphertext` as opaque. It MUST NOT contain,
 * and the server MUST NOT log or attempt to interpret, any plaintext.
 * Only the fields below ever reach the backend in the clear — none of them
 * reveal message content. Never add a field that could carry plaintext or key
 * material here without a threat-model review under docs/threat-models/.
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

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');
const objectKey = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !s.includes('://'), 'must be an object key, not a URL');

export const MeSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const PublishKeyPackagesRequestSchema = z.object({
  signaturePublicKey: base64.max(512),
  keyPackages: z.array(base64.max(8192)).min(1).max(100),
});
export type PublishKeyPackagesRequest = z.infer<typeof PublishKeyPackagesRequestSchema>;

export const PublishKeyPackagesResponseSchema = z.object({
  deviceId: z.string().uuid(),
  published: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
});
export type PublishKeyPackagesResponse = z.infer<typeof PublishKeyPackagesResponseSchema>;

export const RevokeKeyPackagesRequestSchema = z.object({
  signaturePublicKey: base64.max(512),
});
export type RevokeKeyPackagesRequest = z.infer<typeof RevokeKeyPackagesRequestSchema>;

export const RevokeKeyPackagesResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeKeyPackagesResponse = z.infer<typeof RevokeKeyPackagesResponseSchema>;

export const UserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserDirectorySchema = z.array(UserSummarySchema);
export type UserDirectory = z.infer<typeof UserDirectorySchema>;

export const ClaimedKeyPackageSchema = z.object({
  deviceId: z.string().uuid(),
  signaturePublicKey: base64,
  keyPackage: base64,
});
export type ClaimedKeyPackage = z.infer<typeof ClaimedKeyPackageSchema>;

export const CreateConversationRequestSchema = z.object({
  memberUserIds: z.array(z.string().uuid()).min(1).max(256),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const CreatedConversationSchema = z.object({
  conversationId: z.string().uuid(),
});
export type CreatedConversation = z.infer<typeof CreatedConversationSchema>;

export const DeliverWelcomeRequestSchema = z.object({
  recipientUserId: z.string().uuid(),
  recipientDeviceId: z.string().uuid(),
  welcome: base64.min(1).max(32768),
  ratchetTree: base64.min(1).max(32768),
});
export type DeliverWelcomeRequest = z.infer<typeof DeliverWelcomeRequestSchema>;

export const DeliveredWelcomeSchema = z.object({
  welcomeId: z.string().uuid(),
});
export type DeliveredWelcome = z.infer<typeof DeliveredWelcomeSchema>;

export const PendingWelcomeSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  // Who added you (the VERIFIED deliverer, set server-side) — lets the client name the new conversation
  // via the directory. Tells the recipient nothing the first message wouldn't (messages already carry
  // senderUserId), and the server already stores it on the welcome row. Ids/metadata only.
  senderUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type PendingWelcome = z.infer<typeof PendingWelcomeSchema>;

export const PendingWelcomesSchema = z.array(PendingWelcomeSchema);
export type PendingWelcomes = z.infer<typeof PendingWelcomesSchema>;

export const WelcomeMaterialSchema = z.object({
  welcome: base64,
  ratchetTree: base64,
});
export type WelcomeMaterial = z.infer<typeof WelcomeMaterialSchema>;

export const SendConversationMessageRequestSchema = z.object({
  clientMessageId: z.string().uuid(),
  ciphertext: base64.min(1).max(65536),
  alg: z.string().min(1).max(64),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  attachmentObjectKey: objectKey.optional(),
});
export type SendConversationMessageRequest = z.infer<typeof SendConversationMessageRequestSchema>;

export const SentMessageSchema = z.object({
  messageId: z.string().uuid(),
  createdAt: z.string().datetime(),
  deduplicated: z.boolean(),
});
export type SentMessage = z.infer<typeof SentMessageSchema>;

export const FetchedMessageSchema = z.object({
  id: z.string().uuid(),
  senderUserId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  ciphertext: base64,
  alg: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  attachmentObjectKey: objectKey.nullable(),
  createdAt: z.string().datetime(),
});
export type FetchedMessage = z.infer<typeof FetchedMessageSchema>;

export const MessagePageSchema = z.object({
  messages: z.array(FetchedMessageSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type MessagePage = z.infer<typeof MessagePageSchema>;

export const CreateUploadGrantRequestSchema = z.object({
  conversationId: z.string().uuid(),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
export type CreateUploadGrantRequest = z.infer<typeof CreateUploadGrantRequestSchema>;

export const UploadGrantSchema = z.object({
  objectKey,
  uploadUrl: z.string().url(),
});
export type UploadGrant = z.infer<typeof UploadGrantSchema>;

export const CreateDownloadGrantRequestSchema = z.object({
  objectKey,
});
export type CreateDownloadGrantRequest = z.infer<typeof CreateDownloadGrantRequestSchema>;

export const DownloadGrantSchema = z.object({
  url: z.string().url(),
});
export type DownloadGrant = z.infer<typeof DownloadGrantSchema>;

// Opaque sealed backup blob — the server stores and returns it verbatim (never parsed, crypto-blind).
// Size-capped at 64 KiB to match the server enforcement in key-backup.schemas.ts.
export const StoreBackupRequestSchema = z.object({ backup: z.string().min(1).max(65536) }).strict();
export type StoreBackupRequest = z.infer<typeof StoreBackupRequestSchema>;

// Cap the response at the same 64 KiB as the request: the fetched blob is JSON.parsed + Argon2id-unsealed
// client-side, so bounding it stops a misbehaving/compromised server from forcing an oversized parse + KDF.
export const BackupResponseSchema = z.object({ backup: z.string().min(1).max(65536) });
export type BackupResponse = z.infer<typeof BackupResponseSchema>;

// Delivery/read receipts (checkpoint 31). Metadata only — a member id + a "through message id" + when.
// Mirrors the server-local RecordReceiptSchema in apps/api messaging.schemas.ts (same de-facto duplication
// as SendMessage above; the server doesn't import this package).
export const ReceiptStatusSchema = z.enum(['delivered', 'read']);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const RecordReceiptRequestSchema = z
  .object({
    status: ReceiptStatusSchema,
    // The message the caller has received/read THROUGH — all earlier messages implied.
    throughMessageId: z.string().uuid(),
  })
  .strict();
export type RecordReceiptRequest = z.infer<typeof RecordReceiptRequestSchema>;

// One member's delivered/read high-water-marks (GET /conversations/:id/receipts). Watermarks are null
// until the member first acks. Matches ConversationReceiptDto in apps/api receipts.controller.ts.
export const ConversationReceiptSchema = z.object({
  userId: z.string().uuid(),
  deliveredThroughMessageId: z.string().uuid().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  readThroughMessageId: z.string().uuid().nullable(),
  readAt: z.string().datetime().nullable(),
});
export type ConversationReceipt = z.infer<typeof ConversationReceiptSchema>;

export const ConversationReceiptsSchema = z.array(ConversationReceiptSchema);
export type ConversationReceipts = z.infer<typeof ConversationReceiptsSchema>;

// The `receipt` WS frame the gateway pushes to a conversation room when a member advances a watermark
// (checkpoint 31 live push). Metadata only — never content. `userId` is the member who acked.
export const ReceiptEventSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
  status: ReceiptStatusSchema,
  throughMessageId: z.string().uuid(),
});
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;
