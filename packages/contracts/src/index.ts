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

// Plan tier — returned in GET /me so the frontend can gate UI without a separate request.
export const PlanTierSchema = z.enum(['free', 'pro', 'enterprise']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const SubscriptionStatusSchema = z.enum([
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const TenantPlanSchema = z.object({
  tier: PlanTierSchema,
  memberLimit: z.number().int().nullable(),
  ssoEnabled: z.boolean(),
  memberCount: z.number().int(),
  subscriptionStatus: SubscriptionStatusSchema.nullable(),
});
export type TenantPlan = z.infer<typeof TenantPlanSchema>;

// GET /me — discriminated union: unbound users (no tenant yet) vs. bound users.
export const MeUnboundSchema = z.object({ bound: z.literal(false) });
export type MeUnbound = z.infer<typeof MeUnboundSchema>;

export const MeBoundSchema = z.object({
  bound: z.literal(true),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  argusId: z.string(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  plan: TenantPlanSchema,
});
export type MeBound = z.infer<typeof MeBoundSchema>;

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

export const ConversationListSchema = z.object({ conversationIds: z.array(z.string().uuid()) });
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

// ── G1: self-serve tenant onboarding ────────────────────────────────────────

export const CreateTenantBodySchema = z
  .object({
    /** Tenant display name. Not secret and not indexed for search; metadata only. */
    name: z.string().min(1).max(100).trim(),
  })
  .strict();
export type CreateTenantBody = z.infer<typeof CreateTenantBodySchema>;

export const CreateTenantResponseSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

export const CreateInviteBodySchema = z
  .object({
    /** Optional email hint — if set, only the matching Zitadel identity may accept. */
    inviteeEmail: z.string().email().optional(),
  })
  .strict();
export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;

export const CreateInviteResponseSchema = z.object({
  inviteId: z.string().uuid(),
  /** The one-time plaintext token. Return once; never stored. The recipient uses it in AcceptInviteBody. */
  token: z.string(),
  expiresAt: z.string().datetime(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

export const AcceptInviteBodySchema = z.object({ token: z.string().min(1).max(128) }).strict();
export type AcceptInviteBody = z.infer<typeof AcceptInviteBodySchema>;

export const InviteSummarySchema = z.object({
  id: z.string().uuid(),
  inviteeEmail: z.string().email().nullable(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type InviteSummary = z.infer<typeof InviteSummarySchema>;

export const MemberSummarySchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  role: z.enum(['admin', 'member']),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;

export const DeviceSummarySchema = z.object({
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string().max(128).nullable(),
  email: z.string().email(),
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

// ── G2: Per-tenant SSO ────────────────────────────────────────────────────────

export const SsoProviderTypeSchema = z.enum(['oidc_generic', 'google', 'entra', 'okta']);
export type SsoProviderType = z.infer<typeof SsoProviderTypeSchema>;

export const CreateSsoConfigBodySchema = z
  .object({
    providerType: SsoProviderTypeSchema,
    providerName: z.string().min(1).max(100).trim(),
    issuerUrl: z.string().url().max(512),
    clientId: z.string().min(1).max(256),
    /** Request-only. Never stored in our DB; passed to Zitadel only. Never returned. */
    clientSecret: z.string().min(1).max(1024),
  })
  .strict();
export type CreateSsoConfigBody = z.infer<typeof CreateSsoConfigBodySchema>;

export const UpdateSsoConfigBodySchema = z
  .object({
    providerName: z.string().min(1).max(100).trim().optional(),
    issuerUrl: z.string().url().max(512).optional(),
    clientId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required');
export type UpdateSsoConfigBody = z.infer<typeof UpdateSsoConfigBodySchema>;

export const RotateSsoSecretBodySchema = z
  .object({ clientSecret: z.string().min(1).max(1024) })
  .strict();
export type RotateSsoSecretBody = z.infer<typeof RotateSsoSecretBodySchema>;

/** Response schema — NO clientSecret field. */
export const SsoConfigSchema = z.object({
  id: z.string().uuid(),
  providerType: SsoProviderTypeSchema,
  providerName: z.string().max(100),
  issuerUrl: z.string().url().max(512),
  clientId: z.string().max(256),
  loginUrl: z.string().url().max(1024),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SsoConfig = z.infer<typeof SsoConfigSchema>;

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
      email: z.string().email(),
      displayName: z.string().nullable(),
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
  keyBackup: z.object({
    exists: z.boolean(),
    createdAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
  }),
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
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
    }),
  ),
  invitesCreated: z.array(
    z.object({
      id: z.string().uuid(),
      inviteeEmail: z.string().email().nullable(),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      acceptedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    }),
  ),
});
export type MeExport = z.infer<typeof MeExportSchema>;
