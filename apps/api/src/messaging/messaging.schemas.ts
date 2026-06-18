import { z } from 'zod';

// Local for now (no client consumer yet). Mirrors the @argus/contracts envelope; migrate to the shared
// package when the web client sends messages. `.strict()` rejects unknown keys (fail-closed).

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

export const CreateConversationSchema = z
  .object({
    // The OTHER participants — the creator is always added automatically.
    memberUserIds: z.array(z.string().uuid()).min(1).max(256),
    // Explicit classification so the server does not infer it from the initial solo member list
    // (groups start as solo rows before members join, which would make them appear as isDirect=true).
    // Optional with default=false so stale PWA bundles that omit the field keep working after deploy.
    isDirect: z.boolean().optional().default(false),
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

export const ListWelcomesQuerySchema = z
  .object({
    // The calling device — returns only welcomes sealed to its KeyPackage.
    deviceId: z.string().uuid(),
    // Bound the connect-time fetch so a member spamming an offline device can't make GET /welcomes grow
    // without limit (each row carries two ≤32 KiB blobs). Welcomes are transient: the client drains the
    // queue by consuming each one, then re-fetching — so a plain cap (no cursor) is enough.
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListWelcomesQuery = z.infer<typeof ListWelcomesQuerySchema>;

// Shared by the proof-gated welcome ops (fetch-material + consume): both prove possession of the device's
// signature key over (deviceId, welcomeId) before the server hands over / deletes the device's join material.
export const WelcomeProofQuerySchema = z
  .object({
    // The calling device — must be a device of the verified caller; the welcome is sealed to it.
    deviceId: z.string().uuid(),
    // Proof of possession of that device's signature private key over (deviceId, welcomeId): an Ed25519
    // signature, base64url. A 64-byte sig is 86 base64url chars; 256 is generous headroom. NOT a secret —
    // it's a single-use signature over public ids — so a query param (vs a header/body) is fine; it carries
    // no token/credential value if it lands in a log.
    proof: base64url.min(1).max(256),
  })
  .strict();
export type WelcomeProofQuery = z.infer<typeof WelcomeProofQuerySchema>;

export const CommitWelcomeSchema = z
  .object({
    recipientUserId: z.string().uuid(),
    recipientDeviceId: z.string().uuid(),
    welcome: base64.min(1).max(32768),
    ratchetTree: base64.min(1).max(32768),
  })
  .strict();

export const CommitBodySchema = z
  .object({
    clientCommitId: z.string().uuid(),
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    commit: base64.min(1).max(65536),
    welcomes: z.array(CommitWelcomeSchema).max(64),
    addedUserIds: z.array(z.string().uuid()).max(32),
    removedUserIds: z.array(z.string().uuid()).max(32),
  })
  .strict();
export type CommitBody = z.infer<typeof CommitBodySchema>;

export const ListCommitsQuerySchema = z
  .object({
    afterEpoch: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export type ListCommitsQuery = z.infer<typeof ListCommitsQuerySchema>;

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
