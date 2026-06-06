import { z } from 'zod';

// Local for now (no client consumer yet). Mirrors the @argus/contracts envelope; migrate to the shared
// package when the web client sends messages. `.strict()` rejects unknown keys (fail-closed).

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

export const CreateConversationSchema = z
  .object({
    // The OTHER participants — the creator is always added automatically. 1:1 = a single other user.
    memberUserIds: z.array(z.string().uuid()).min(1).max(256),
  })
  .strict();
export type CreateConversation = z.infer<typeof CreateConversationSchema>;

export const ListMessagesQuerySchema = z
  .object({
    // Query params arrive as strings → coerce. `after` is an exclusive keyset cursor (a message id).
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: z.string().uuid().optional(),
  })
  .strict();
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const SyncQuerySchema = z
  .object({
    // `after` is the previous page's OPAQUE `nextCursor` (an encoded (created_at, id) token — NOT a
    // message id). Treated as opaque by the client; bounded length, structure validated on decode.
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: z.string().min(1).max(256).optional(),
  })
  .strict();
export type SyncQuery = z.infer<typeof SyncQuerySchema>;

export const RecordReceiptSchema = z
  .object({
    status: z.enum(['delivered', 'read']),
    // The message the caller has received/read THROUGH (all earlier messages implied).
    throughMessageId: z.string().uuid(),
  })
  .strict();
export type RecordReceipt = z.infer<typeof RecordReceiptSchema>;

export const DeliverWelcomeSchema = z
  .object({
    // The user being ADDED — must be a user in the caller's tenant (composite FK → 400). Becomes a member.
    recipientUserId: z.string().uuid(),
    // The recipient's DEVICE whose claimed KeyPackage this Welcome is sealed to — must be a device of
    // recipientUserId in this tenant (composite FK → 400). Routes the welcome to the right device.
    recipientDeviceId: z.string().uuid(),
    // Opaque MLS Welcome + RatchetTree (base64). The server stores + forwards; it NEVER decrypts them —
    // they carry the group's key material sealed to the recipient's KeyPackage HPKE key. 32 KiB each:
    // ample for a v1 1:1 add (a Welcome/RatchetTree is a few hundred bytes to a few KB) and it keeps the
    // whole request under the platform's ~100 KB JSON body cap (Express default; main.ts). Larger N-party
    // RatchetTrees (B1 group chat) will need that body cap raised in tandem — see welcome-delivery.md §6.
    welcome: base64.min(1).max(32768),
    ratchetTree: base64.min(1).max(32768),
  })
  .strict();
export type DeliverWelcome = z.infer<typeof DeliverWelcomeSchema>;

export const SendMessageSchema = z
  .object({
    clientMessageId: z.string().uuid(), // client-generated; idempotency key (per sender)
    ciphertext: base64.min(1).max(65536), // opaque MLS blob — the server never parses it
    alg: z.string().min(1).max(64), // AEAD/version tag, e.g. "MLS_1.0"
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), // MLS epoch
    // Optional reference to an already-uploaded ENCRYPTED blob — a tenant-scoped object key, NEVER a URL
    // (presigned URLs must never be persisted/logged — invariant #2).
    attachmentObjectKey: z
      .string()
      .min(1)
      .max(512)
      .refine((s) => !s.includes('://'), 'must be an object key, not a URL')
      .optional(),
  })
  .strict();
export type SendMessage = z.infer<typeof SendMessageSchema>;
