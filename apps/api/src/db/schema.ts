import { bigint, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Typed table definitions for query building. The authoritative DDL — including RLS
// policies, FORCE RLS, indexes and grants — lives in ./migrations/*.sql (Drizzle's schema
// layer does not express row-level security).

// Tenant ROOT: its own id IS the tenant, so it has no tenant_id column (see migration).
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  externalIdentityId: text('external_identity_id').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Key directory (roadmap 19) — PUBLIC MLS key material only (base64 text, opaque to the server).
export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  signaturePublicKey: text('signature_public_key').notNull(),
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
  createdBy: uuid('created_by').notNull(),
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
  senderUserId: uuid('sender_user_id').notNull(),
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
