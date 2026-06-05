import { inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
