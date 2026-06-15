import {
  bigint,
  boolean,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Typed table definitions for query building. The authoritative DDL — including RLS
// policies, FORCE RLS, indexes and grants — lives in ./migrations/*.sql (Drizzle's schema
// layer does not express row-level security).

// Tenant ROOT: its own id IS the tenant, so it has no tenant_id column (see migration).
// Plan and billing columns added in migration 0022. tenants has FORCE RLS (tenants_self_isolation
// policy, keyed on app.tenant_id) — all queries must run inside withTenant(tenantId).
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Plan gating (G8)
  planTier: text('plan_tier').notNull().default('free'),
  memberLimit: integer('member_limit').default(10),
  ssoEnabled: boolean('sso_enabled').notNull().default(false),
  planSetAt: timestamp('plan_set_at', { withTimezone: true }).notNull().defaultNow(),
  // Stripe subscription (G8)
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionStatus: text('subscription_status'),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  externalIdentityId: text('external_identity_id').notNull(),
  argusId: text('argus_id').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  status: text('status').notNull().default('active'),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Key directory (roadmap 19) — PUBLIC MLS key material only (base64 text, opaque to the server).
export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  signaturePublicKey: text('signature_public_key').notNull(),
  /** Provisional = freshly published, not yet verified by enrollment approval. Only non-provisional
   * devices may approve new enrollments. Promoted to false by approveEnrollment. */
  isProvisional: boolean('is_provisional').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const keyPackages = pgTable('key_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  keyPackage: text('key_package').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Passphrase-sealed key backup — ciphertext only, opaque to the server (roadmap 22). RLS in 0006.
export const keyBackups = pgTable('key_backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  backup: text('backup').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Messaging (roadmap 25) — CIPHERTEXT ONLY for content. RLS + grants in 0007. See messaging-schema.md.
// A conversation / MLS group — metadata only (no name/title: that would be plaintext metadata).
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by'), // nullable after GDPR erasure (migration 0020)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// User-level membership; drives app-layer send/read authz (26).
export const conversationMembers = pgTable('conversation_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  userId: uuid('user_id').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
});

// Messages — `ciphertext` is the opaque base64 MLS blob (never decrypted server-side); the rest is
// routing/version/dedup metadata. No plaintext-bearing column.
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  senderUserId: uuid('sender_user_id'), // nullable after GDPR erasure (migration 0020)
  clientMessageId: uuid('client_message_id').notNull(),
  ciphertext: text('ciphertext').notNull(),
  alg: text('alg').notNull(),
  epoch: bigint('epoch', { mode: 'bigint' }).notNull(),
  attachmentObjectKey: text('attachment_object_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Delivery/read high-water-marks per (conversation, member) — METADATA only (roadmap 31). RLS in 0010.
export const conversationReceipts = pgTable('conversation_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  userId: uuid('user_id').notNull(),
  deliveredThroughMessageId: uuid('delivered_through_message_id'),
  deliveredThroughCreatedAt: timestamp('delivered_through_created_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readThroughMessageId: uuid('read_through_message_id'),
  readThroughCreatedAt: timestamp('read_through_created_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Encrypted image attachments — METADATA + ciphertext REFS only (0011). The ciphertext blob lives in
// object storage; the content key lives only in the MLS envelope. No content / content-key / plaintext
// content-type column. RLS + composite-FK tenant pinning in 0011. See encrypted-attachments.md.
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  objectKey: text('object_key').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  uploadedBy: uuid('uploaded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

// MLS Welcome delivery — opaque join material relayed to an added member (0012). `welcome` +
// `ratchet_tree` are ciphertext-only base64 the server never decrypts; transient (consumed on join).
// RLS + composite-FK tenant pinning in 0012. See welcome-delivery.md.
export const conversationWelcomes = pgTable('conversation_welcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  recipientUserId: uuid('recipient_user_id').notNull(),
  // The specific device whose claimed KeyPackage the Welcome is sealed to (multi-device routing).
  recipientDeviceId: uuid('recipient_device_id').notNull(),
  senderUserId: uuid('sender_user_id').notNull(),
  welcome: text('welcome').notNull(),
  ratchetTree: text('ratchet_tree').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Web Push subscriptions — one per device (0017). endpoint/p256dh/auth are push-transport metadata only;
// no message content. RLS + composite-FK cascade in 0017. See web-push.md.
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  userId: uuid('user_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// G1: sub→tenant routing index. No RLS — looked up before tenant context exists.
// argus_app: SELECT + INSERT only (bindings immutable from the app path). See 0018.
export const userTenantIndex = pgTable('user_tenant_index', {
  sub: text('sub').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Stripe webhook idempotency log. Global (no tenant_id, NO RLS) — like user_tenant_index, this is
// operational data, not tenant-scoped: only Stripe event ids/types/timestamps, no content, no PII. See 0029.
export const stripeEvents = pgTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

// G1: admin-issued invite tokens (hash-at-rest). Tenant-scoped + FORCE RLS. See 0018.
export const tenantInvites = pgTable('tenant_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  tokenHash: text('token_hash').notNull(),
  inviteeEmail: text('invitee_email'),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  acceptedBy: uuid('accepted_by'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// G2: per-tenant OIDC SSO config (one per tenant, lazy). client_secret is NOT stored here —
// it lives in Zitadel only. All SSO endpoints are admin-only. See 0019 + per-tenant-sso.md.
export const tenantSsoConfigs = pgTable('tenant_sso_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  zitadelOrgId: text('zitadel_org_id').notNull(),
  zitadelIdpId: text('zitadel_idp_id').notNull(),
  providerType: text('provider_type').notNull(),
  providerName: text('provider_name').notNull(),
  issuerUrl: text('issuer_url').notNull(),
  clientId: text('client_id').notNull(),
  loginUrl: text('login_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// B1: MLS group-commit fan-out. `commit` is opaque mls_private_message base64; server stores +
// forwards only (invariant #1). Epoch lock: UNIQUE (tenant_id, conversation_id, epoch).
// DDL, RLS, index, and grants live in 0023_conversation_commits.sql.
export const conversationCommits = pgTable('conversation_commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  senderUserId: uuid('sender_user_id'), // nullable — GDPR erasure parity with messages
  clientCommitId: uuid('client_commit_id').notNull(),
  epoch: bigint('epoch', { mode: 'bigint' }).notNull(),
  commit: text('commit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// B2: multi-device enrollment coordination. Metadata only — the server never makes the trust decision.
// fingerprint is public (derived from D2's published signature key); status drives D1 inbox routing.
// DDL, RLS, indexes and grants live in 0024_device_enrollments.sql.
export const deviceEnrollments = pgTable('device_enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  requestingDeviceId: uuid('requesting_device_id').notNull(),
  approvedByDeviceId: uuid('approved_by_device_id'),
  fingerprint: text('fingerprint').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// Phase 1 — self-minted session tokens. Stateful refresh token storage. FORCE RLS, see 0031.
// Access tokens are stateless JWTs; only refresh state lives here (hashed, never plain).
export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  sub: text('sub').notNull(), // "argusid:<argus_id>", for access-token re-mint
  refreshTokenHash: text('refresh_token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// Append-only audit log (IDs + metadata only — never content/secrets). RLS + grants in 0002.
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  eventType: text('event_type').notNull(),
  actorSub: text('actor_sub'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
