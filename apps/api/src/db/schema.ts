import {
  bigint,
  boolean,
  customType,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// bytea column type — used for WebAuthn credential blobs (raw bytes, not base64).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// Typed table definitions for query building. The authoritative DDL — including RLS
// policies, FORCE RLS, indexes and grants — lives in ./migrations/*.sql (Drizzle's schema
// layer does not express row-level security).

// Tenant ROOT: its own id IS the tenant, so it has no tenant_id column (see migration).
// tenants has FORCE RLS (tenants_self_isolation policy, keyed on app.tenant_id) — all queries must
// run inside withTenant(tenantId). The plan/billing columns (migration 0022: plan_tier, member_limit,
// sso_enabled, plan_set_at, stripe_*, subscription_status) are INERT after Phase 6 — left in the DB
// for a later dedicated drop migration, intentionally not typed here so no code can read them.
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  externalIdentityId: text('external_identity_id').notNull(),
  argusId: text('argus_id').notNull(),
  email: text('email'),
  displayName: text('display_name'),
  avatarSeed: text('avatar_seed'),
  status: text('status').notNull().default('active'),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Privacy preferences (0046). NULL = use server default (true). Coerced before returning to clients.
  privacyReadReceipts: boolean('privacy_read_receipts'),
  privacyTypingIndicators: boolean('privacy_typing_indicators'),
  privacyLinkPreviews: boolean('privacy_link_previews'),
  // Call relay preference (0047). NOT NULL; default true = relay-only (privacy-first).
  callRelayOnly: boolean('call_relay_only').notNull().default(true),
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

// Messaging (roadmap 25) — CIPHERTEXT ONLY for content. RLS + grants in 0007. See messaging-schema.md.
// A conversation / MLS group — metadata only (no name/title: that would be plaintext metadata).
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by'), // nullable after GDPR erasure (migration 0020)
  isDirect: boolean('is_direct'), // null = pre-migration; true = 1:1; false = group (migration 0041)
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

// NOTE: the `stripe_events` table (migration 0029) is INERT after Phase 6 — billing was removed — and is
// intentionally left in the DB (untyped here) for a later dedicated drop migration, like the inert plan/
// stripe columns on `tenants`.

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

// Phase 2 — WebAuthn passkey credentials. One row per registered passkey. FORCE RLS, see 0033.
// credential_id is stored as raw bytes (bytea); encode/decode at the service boundary.
// See docs/threat-models/passkey-auth.md.
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  credentialId: bytea('credential_id').notNull(),
  publicKey: bytea('public_key').notNull(), // COSE-encoded; server-auth only, not E2EE
  counter: bigint('counter', { mode: 'bigint' }).notNull().default(BigInt(0)),
  aaguid: uuid('aaguid'), // best-effort, often zero under attestationType:'none'
  backedUp: boolean('backed_up').notNull().default(false),
  transports: text('transports').array(),
  deviceLabel: text('device_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

// Phase 2 — ephemeral ceremony state. No-RLS routing table; access gated by ceremony_id UUID.
// Delete-on-use (DELETE…RETURNING) in service code. See docs/threat-models/registration-and-tenancy.md §T5.
export const webauthnChallenges = pgTable('webauthn_challenges', {
  ceremonyId: uuid('ceremony_id').primaryKey().defaultRandom(),
  challengeHash: text('challenge_hash').notNull(), // hex of 32 raw CSPRNG challenge bytes (not a hash)
  purpose: text('purpose').notNull(), // 'register' | 'authenticate'
  argusId: text('argus_id'), // generated at redeem; same value flows through options → verify → user insert
  inviteId: uuid('invite_id'), // consumed atomically in register/verify tx
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// Friendships (contact-list-recovery Slice C) — mutual friendship graph, METADATA ONLY (no keys, no content).
// Canonical pair ordering: userLowId = least(a, b), userHighId = greatest(a, b) — one row per pair.
// Accepted-only model: pending requests TTL'd; decline/cancel = hard DELETE (no rejection ledger).
// DDL, RLS (FORCE), indexes, and grants live in 0042_friendships.sql.
// See docs/threat-models/contact-list-recovery.md §R-friends.
export const friendships = pgTable('friendships', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userLowId: uuid('user_low_id').notNull(), // canonical: least(userId_a, userId_b)
  userHighId: uuid('user_high_id').notNull(), // canonical: greatest(userId_a, userId_b)
  status: text('status').notNull(), // 'pending' | 'accepted'
  requestedBy: uuid('requested_by'), // who opened it; NULLed on accept
  expiresAt: timestamp('expires_at', { withTimezone: true }), // pending TTL; NULL once accepted
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }), // set on accept
});

// Phase 3 — breakglass admin credential. Argon2id-hashed password + lockout state. FORCE RLS, see 0037.
// See docs/threat-models/breakglass-admin.md.
export const adminCredentials = pgTable('admin_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(), // base64 raw 32-byte Argon2id output; never plaintext
  salt: text('salt').notNull(), // base64 16-byte CSPRNG salt
  kdfParams: jsonb('kdf_params').notNull().$type<{ m: number; t: number; p: number }>(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
