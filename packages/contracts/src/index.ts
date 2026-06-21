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

// GET /me — discriminated union: unbound users (no tenant yet) vs. bound users.
export const MeUnboundSchema = z.object({ bound: z.literal(false) });
export type MeUnbound = z.infer<typeof MeUnboundSchema>;

// ── WebAuthn / passkey (Phase 2) ──────────────────────────────────────────────────────────────

export const RedeemCodeRequestSchema = z.object({
  code: z.string().min(1).max(256),
});
export type RedeemCodeRequest = z.infer<typeof RedeemCodeRequestSchema>;

export const RedeemCodeResponseSchema = z.object({
  ceremonyId: z.string().uuid(),
});
export type RedeemCodeResponse = z.infer<typeof RedeemCodeResponseSchema>;

export const RegisterOptionsRequestSchema = z.object({
  ceremonyId: z.string().uuid(),
});
export type RegisterOptionsRequest = z.infer<typeof RegisterOptionsRequestSchema>;

// The backend returns the raw PublicKeyCredentialCreationOptions JSON directly.
export const RegisterOptionsResponseSchema = z.record(z.string(), z.unknown());
export type RegisterOptionsResponse = z.infer<typeof RegisterOptionsResponseSchema>;

export const RegisterVerifyRequestSchema = z.object({
  ceremonyId: z.string().uuid(),
  registrationResponse: z.record(z.string(), z.unknown()),
});
export type RegisterVerifyRequest = z.infer<typeof RegisterVerifyRequestSchema>;

export const AuthenticateOptionsResponseSchema = z.object({
  ceremonyId: z.string().uuid(),
  options: z.record(z.string(), z.unknown()),
});
export type AuthenticateOptionsResponse = z.infer<typeof AuthenticateOptionsResponseSchema>;

export const AuthenticateVerifyRequestSchema = z.object({
  ceremonyId: z.string().uuid(),
  authenticationResponse: z.record(z.string(), z.unknown()),
});
export type AuthenticateVerifyRequest = z.infer<typeof AuthenticateVerifyRequestSchema>;

export const AccessTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
});
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────

export const MeBoundSchema = z.object({
  bound: z.literal(true),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  argusId: z.string(),
  displayName: z.string().nullable(),
  avatarSeed: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  /** True for the breakglass admin account — front-end gates profile editing on this. */
  isBreakglass: z.boolean().optional(),
});
export type MeBound = z.infer<typeof MeBoundSchema>;

export const UserLookupResultSchema = z.object({
  userId: z.string().uuid(),
  argusId: z.string(),
  displayName: z.string().nullable(),
  avatarSeed: z.string().nullable(),
});
export type UserLookupResult = z.infer<typeof UserLookupResultSchema>;

export const ConversationMemberSchema = z.object({
  userId: z.string().uuid(),
  argusId: z.string(),
  displayName: z.string().nullable(),
  avatarSeed: z.string().nullable(),
});
export type ConversationMember = z.infer<typeof ConversationMemberSchema>;

/** Names that must never be user-settable (compared case-insensitively). */
const RESERVED_DISPLAY_NAMES = new Set(['breakglass-admin']);

/**
 * Display-name constraints, exported so the OpenAPI spec can advertise the EXACT same contract the
 * server enforces (kept in lockstep with `displayNameSchema`). The pattern is a single character
 * class with one `+` quantifier — linear, ReDoS-safe, and bounded by `DISPLAY_NAME_MAX`.
 */
export const DISPLAY_NAME_PATTERN = "^[A-Za-z0-9 ._'-]+$";
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 32;
/** Human-readable description of the allow-list — shared by the regex error message and the UI hint. */
export const DISPLAY_NAME_ALLOWED = "letters, numbers, spaces, and . _ - '";

/**
 * Hardened display-name policy, shared by the web form and the API (single source of truth).
 *
 * After trimming and collapsing internal whitespace runs to a single space, the value must be
 * 2–32 characters drawn from a strict Latin allow-list: letters `A–Za–z`, digits `0–9`, space,
 * and `. _ - '`. That allow-list inherently rejects control characters, zero-width characters,
 * bidirectional overrides (RTL "Trojan" text), Unicode separators, emoji, and combining-mark
 * (Zalgo) spam — so a name cannot be used to hide content, spoof, or impersonate. Reserved
 * sentinels (e.g. the breakglass admin) are blocked too.
 */
export const displayNameSchema = z
  .string()
  .trim()
  // Collapse runs of plain spaces only — newlines/tabs/other whitespace are left intact so the
  // allow-list below rejects them rather than silently turning them into a space.
  .transform((v) => v.replace(/ +/g, ' '))
  .pipe(
    z
      .string()
      .min(DISPLAY_NAME_MIN, `display name must be at least ${DISPLAY_NAME_MIN} characters`)
      .max(DISPLAY_NAME_MAX, `display name must be at most ${DISPLAY_NAME_MAX} characters`)
      .regex(new RegExp(DISPLAY_NAME_PATTERN), `display name may use ${DISPLAY_NAME_ALLOWED} only`)
      .refine((v) => !RESERVED_DISPLAY_NAMES.has(v.toLowerCase()), {
        message: 'reserved display name',
      }),
  );

export const UpdateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  avatarSeed: z.string().min(1).max(64).optional(),
});
export type UpdateProfile = z.infer<typeof UpdateProfileSchema>;

// ─── Friends (contact-list recovery) ──────────────────────────────────────────────────────────────
// Server-backed friend graph: accepted friendships are the durable contact source after a reinstall.
// Requests are ephemeral (TTL'd pending; decline/cancel = hard DELETE). The server stores metadata only.

/** Send a friend request, addressed by the target's exact argus-id (same bound as the lookup query). */
export const SendFriendRequestSchema = z.object({
  argusId: z.string().min(1).max(128),
});
export type SendFriendRequest = z.infer<typeof SendFriendRequestSchema>;

/**
 * Uniform response to a send-request — a CONSTANT body for every outcome (found / not-found / inactive
 * / self / already-friends / already-pending). Carries no outcome signal, so it is not an enumeration
 * oracle; it exists only so the 202 has a typed body.
 */
export const SendFriendRequestResponseSchema = z.object({
  status: z.literal('accepted'),
});
export type SendFriendRequestResponse = z.infer<typeof SendFriendRequestResponseSchema>;

/** Which mailbox of open requests to read: requests sent TO me, or requests sent BY me. */
export const FriendRequestBoxSchema = z.enum(['incoming', 'outgoing']);
export type FriendRequestBox = z.infer<typeof FriendRequestBoxSchema>;

/** An accepted friend — the contact-recovery surface. `since` = when the friendship was accepted. */
export const FriendSchema = z.object({
  userId: z.string().uuid(),
  argusId: z.string(),
  displayName: z.string().nullable(),
  avatarSeed: z.string().nullable(),
  since: z.string().datetime(),
});
export type Friend = z.infer<typeof FriendSchema>;

/**
 * An open (pending) friend request. `userId`/`argusId`/… describe the OTHER party; `direction` says
 * whether it is incoming (they asked me) or outgoing (I asked them). `requestId` is the friendship row
 * id used by accept/decline/cancel.
 */
export const FriendRequestSchema = z.object({
  requestId: z.string().uuid(),
  userId: z.string().uuid(),
  argusId: z.string(),
  displayName: z.string().nullable(),
  avatarSeed: z.string().nullable(),
  direction: FriendRequestBoxSchema,
  createdAt: z.string().datetime(),
});
export type FriendRequest = z.infer<typeof FriendRequestSchema>;

export const FriendListResponseSchema = z.object({
  friends: z.array(FriendSchema),
});
export type FriendListResponse = z.infer<typeof FriendListResponseSchema>;

export const FriendRequestListResponseSchema = z.object({
  requests: z.array(FriendRequestSchema),
});
export type FriendRequestListResponse = z.infer<typeof FriendRequestListResponseSchema>;

export const MeSchema = z.discriminatedUnion('bound', [MeUnboundSchema, MeBoundSchema]);
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

export const ClaimedKeyPackageSchema = z.object({
  deviceId: z.string().uuid(),
  signaturePublicKey: base64,
  keyPackage: base64,
});
export type ClaimedKeyPackage = z.infer<typeof ClaimedKeyPackageSchema>;

export const CreateConversationRequestSchema = z.object({
  memberUserIds: z.array(z.string().uuid()).min(1).max(256),
  isDirect: z.boolean(),
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
  /** null when the sender has exercised their GDPR right to erasure (account deleted). */
  senderUserId: z.string().uuid().nullable(),
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

// Web Push subscription (RFC 8291 VAPID). Values are base64url-encoded as returned by PushManager.subscribe().
// The server stores these to send content-free wake-up pings. See web-push.md.
const base64url = z.string().regex(/^[A-Za-z0-9_-]+=*$/, 'must be base64url');
export const PushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    p256dh: base64url.max(256),
    auth: base64url.max(64),
  })
  .strict();
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

// Device enrollment (B2 — multi-device linking). D2 registers a pending enrollment; D1 approves/rejects.
const base64urlStrict = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be unpadded base64url');
export const EnrollmentRegisterBodySchema = z
  .object({
    fingerprint: z.string().min(1).max(512),
    deviceId: z.string().uuid(),
  })
  .strict();
export type EnrollmentRegisterBody = z.infer<typeof EnrollmentRegisterBodySchema>;

export const EnrollmentApproveBodySchema = z
  .object({
    approvingDeviceId: z.string().uuid(),
    proof: base64urlStrict.max(256),
  })
  .strict();
export type EnrollmentApproveBody = z.infer<typeof EnrollmentApproveBodySchema>;

// Phase 3 — breakglass admin login + password rotation.
export const BreakglassLoginRequestSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type BreakglassLoginRequest = z.infer<typeof BreakglassLoginRequestSchema>;

export const BreakglassRotateRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();
export type BreakglassRotateRequest = z.infer<typeof BreakglassRotateRequestSchema>;

export const EnrollmentSchema = z
  .object({
    id: z.string().uuid(),
    requestingDeviceId: z.string().uuid(),
    approvedByDeviceId: z.string().uuid().nullable(),
    fingerprint: z.string(),
    status: z.string(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    /** D1's registered signature public key (base64) — used by D2 to verify D1's claimed key package. */
    approverSignaturePublicKey: z.string().nullable().optional(),
  })
  .strip();
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string().uuid(),
  isDirect: z.boolean().nullable(),
  createdAt: z.string().datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});
export type ConversationList = z.infer<typeof ConversationListSchema>;

export const WithdrawDeviceBodySchema = z
  .object({
    signaturePublicKey: z.string().min(1).max(512),
    proof: base64urlStrict.max(128),
  })
  .strict();
export type WithdrawDeviceBody = z.infer<typeof WithdrawDeviceBodySchema>;

export const SubscribePushRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    subscription: PushSubscriptionSchema,
  })
  .strict();
export type SubscribePushRequest = z.infer<typeof SubscribePushRequestSchema>;

// The `receipt` WS frame the gateway pushes to a conversation room when a member advances a watermark
// (checkpoint 31 live push). Metadata only — never content. `userId` is the member who acked.
export const ReceiptEventSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
  status: ReceiptStatusSchema,
  throughMessageId: z.string().uuid(),
});
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;

// ── B1: MLS group commit fan-out ─────────────────────────────────────────────

// POST /conversations/:id/commits — submit a staged membership commit to win the epoch slot.
// `commit` is the opaque base64 mls_private_message frame. `welcomes` carries the HPKE-sealed
// join material for each added member, one per device. The server stores + forwards; never decrypts.
// `removedUserIds` is the declared delta — server applies it to conversation_members (see threat model
// §T2: the server trusts this assertion; the cryptographic truth is in the commit frame itself).
export const CommitWelcomeSchema = z
  .object({
    recipientUserId: z.string().uuid(),
    recipientDeviceId: z.string().uuid(),
    welcome: base64.max(32768),
    ratchetTree: base64.max(32768),
  })
  .strict();

export const CommitBodySchema = z
  .object({
    clientCommitId: z.string().uuid(),
    epoch: z.number().int().nonnegative(),
    commit: base64.max(65536),
    welcomes: z.array(CommitWelcomeSchema).max(64),
    addedUserIds: z.array(z.string().uuid()).max(32),
    removedUserIds: z.array(z.string().uuid()).max(32),
  })
  .strict();
export type CommitBody = z.infer<typeof CommitBodySchema>;

// 200 on first win; also 200 on own retry (deduplicated: true).
export const CommitResponseSchema = z.object({
  id: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
});
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

// GET /conversations/:id/commits?afterEpoch=N — drain commits for epoch-advance / catch-up.
export const FetchedCommitSchema = z.object({
  id: z.string().uuid(),
  clientCommitId: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  /** null when sender exercised GDPR erasure. */
  senderUserId: z.string().uuid().nullable(),
  commit: base64.max(65536),
  createdAt: z.string().datetime(),
});
export type FetchedCommit = z.infer<typeof FetchedCommitSchema>;

export const CommitPageSchema = z.array(FetchedCommitSchema);
export type CommitPage = z.infer<typeof CommitPageSchema>;

// The `commit` WS frame the gateway pushes when a commit wins its epoch slot. Metadata only —
// the commit ciphertext is NOT included; clients fetch it via GET /commits?afterEpoch=N.
export const CommitEventSchema = z.object({
  conversationId: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  senderUserId: z.string().uuid().nullable(),
  commitId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type CommitEvent = z.infer<typeof CommitEventSchema>;

// The `message` WS frame the gateway pushes when a stored message is fanned out to a subscribed
// socket. Metadata + the opaque envelope only — the ciphertext rides inside `message` (FetchedMessage),
// never decrypted by the server.
//
// `deliverySeq` / `deliveryPrevSeq` are an EPHEMERAL, per-(socket, conversation) TRANSPORT counter the
// gateway stamps at fan-out (1, 2, 3, … for the frames it actually sends THAT socket) so the client can
// notice a dropped or reordered frame and self-heal by re-fetching over the existing message backfill.
// They are NOT the MLS `epoch` and NOT the MLS ratchet generation, and carry NO cryptographic guarantee:
// a gap merely TRIGGERS a re-fetch — it never gates decryption, ordering, or dedup (those remain MLS +
// the durable (created_at, id) cursor + dedup-by-id). Both are optional for backward compatibility — an
// old server omits them (gap-detection simply unavailable) and an old client ignores them.
export const MessageEventSchema = z.object({
  conversationId: z.string().uuid(),
  message: FetchedMessageSchema,
  /** This socket+conversation's transport delivery counter; 1-based, +1 per fanned-out frame. Not the MLS epoch/generation. */
  deliverySeq: z.number().int().positive().optional(),
  /** The deliverySeq of the immediately-preceding frame on this socket+conversation; null on the first frame. */
  deliveryPrevSeq: z.number().int().positive().nullable().optional(),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;

// ── Admin-minted invite / registration codes ────────────────────────────────

export const CreateInviteResponseSchema = z.object({
  inviteId: z.string().uuid(),
  /** The one-time plaintext token. Returned once; never stored. Redeemed by the passkey registration flow. */
  token: z.string(),
  expiresAt: z.string().datetime(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const InviteSummarySchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type InviteSummary = z.infer<typeof InviteSummarySchema>;

export const MemberSummarySchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  role: z.enum(['admin', 'member']),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;

export const DeviceSummarySchema = z.object({
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string().max(128).nullable(),
  signaturePublicKeyPrefix: z.string().max(12),
  createdAt: z.string().datetime(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const AuditEventSummarySchema = z.object({
  id: z.string().uuid(),
  eventType: z.string().max(64),
  actorSub: z.string().max(256).nullable(),
  actorDisplayName: z.string().max(128).nullable(),
  ip: z.string().max(45).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditEventSummary = z.infer<typeof AuditEventSummarySchema>;

export const AdminAuditResponseSchema = z.object({
  events: z.array(AuditEventSummarySchema),
  nextCursor: z.string().optional(),
});
export type AdminAuditResponse = z.infer<typeof AdminAuditResponseSchema>;

// ── G6: GDPR — data export (Art. 20) ─────────────────────────────────────────
// Server is crypto-blind: no ciphertext, content keys, or message plaintext appears here.
// `messageSummary` describes counts and timestamps only. `endpointPrefix` is the first
// 40 chars of the push endpoint URL (enough to identify the push service, not the full
// capability URL).

export const MeExportSchema = z.object({
  schemaVersion: z.literal('1'),
  exportedAt: z.string().datetime(),
  notice: z.string().max(512),
  profile: z
    .object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      argusId: z.string(),
      displayName: z.string().nullable(),
      avatarSeed: z.string().nullable(),
      role: z.string().max(32),
      status: z.string().max(32),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  devices: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
    }),
  ),
  conversations: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
    }),
  ),
  messageSummary: z.object({
    totalCount: z.number().int().nonnegative(),
    byConversation: z.array(
      z.object({
        conversationId: z.string().uuid(),
        count: z.number().int().nonnegative(),
        firstAt: z.string().datetime(),
        lastAt: z.string().datetime(),
      }),
    ),
  }),
  attachments: z.array(
    z.object({
      id: z.string().uuid(),
      conversationId: z.string().uuid(),
      objectKey: z.string().max(512),
      byteSize: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime().nullable(),
    }),
  ),
  pushSubscriptions: z.array(
    z.object({
      id: z.string().uuid(),
      endpointPrefix: z.string().max(64),
      createdAt: z.string().datetime(),
    }),
  ),
  auditEvents: z.array(
    z.object({
      id: z.string().uuid(),
      eventType: z.string().max(64),
      createdAt: z.string().datetime(),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
        .nullable(),
    }),
  ),
  invitesCreated: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      acceptedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    }),
  ),
  // Accepted friendships + open requests where the caller is a party (GDPR Art. 20 completeness).
  // `otherUserId` is the other party; `direction` is set for pending requests only (null once accepted,
  // since requested_by is cleared on accept).
  friendships: z.array(
    z.object({
      id: z.string().uuid(),
      otherUserId: z.string().uuid(),
      status: z.enum(['pending', 'accepted']),
      direction: z.enum(['incoming', 'outgoing']).nullable(),
      createdAt: z.string().datetime(),
      resolvedAt: z.string().datetime().nullable(),
      expiresAt: z.string().datetime().nullable(),
    }),
  ),
});
export type MeExport = z.infer<typeof MeExportSchema>;
