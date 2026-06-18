import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { schema, withTenant } from '../db/index.js';

/**
 * Metadata for the `users.lookup` audit event.
 * Fields are pseudonymous identifiers + a boolean — no PII.
 */
export interface LookupUserMeta {
  targetArgusId: string;
  found: boolean;
}

/**
 * Metadata for the `users.profile_updated` audit event.
 * Only field NAMES are recorded — never the values.
 */
export interface ProfileUpdateMeta {
  fieldsUpdated: ('displayName' | 'avatarSeed')[];
}

/**
 * Metadata for the `friends.request_created` audit event.
 * `targetArgusId` is sanitised by the controller (verbatim only if well-formed, else <invalid-format>)
 * — the friend-request path is a state-changing argus-id probe (R-friends-3). We deliberately record
 * ONLY the probed argus-id, NOT whether it matched an active user: the probe pattern is visible from the
 * argus-id sequence for abuse detection, while a stored `found` boolean would be replayable to the actor
 * via the GDPR Art. 20 export — a durable enumeration oracle defeating the uniform-202. No PII, no content.
 */
export interface FriendRequestMeta {
  targetArgusId: string;
}

export type AuditMetadata = LookupUserMeta | ProfileUpdateMeta | FriendRequestMeta;

export interface AuditEventInput {
  eventType: string;
  /** Verified OIDC subject (an identifier — never a token). */
  actorSub?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Structured non-sensitive metadata validated against a strict schema before insert. */
  metadata?: AuditMetadata;
}

const LookupUserMetaSchema = z.object({
  targetArgusId: z.string().max(128),
  found: z.boolean(),
});

const ProfileUpdateMetaSchema = z.object({
  fieldsUpdated: z.array(z.enum(['displayName', 'avatarSeed'])).max(2),
});

const FriendRequestMetaSchema = z.object({
  targetArgusId: z.string().max(128),
});

function validateMetadata(eventType: string, metadata: AuditMetadata): AuditMetadata {
  if (eventType === 'users.lookup') return LookupUserMetaSchema.parse(metadata);
  if (eventType === 'users.profile_updated') return ProfileUpdateMetaSchema.parse(metadata);
  if (eventType === 'friends.request_created') return FriendRequestMetaSchema.parse(metadata);
  throw new Error(`No metadata schema registered for eventType "${eventType}"`);
}

@Injectable()
export class AuditService {
  /** Append one audit row inside the verified tenant's RLS context. IDs + metadata only. */
  async record(tenantId: string, event: AuditEventInput): Promise<void> {
    const metadata = event.metadata ? validateMetadata(event.eventType, event.metadata) : null;
    await withTenant(tenantId, async (tx) => {
      await tx.insert(schema.auditEvents).values({
        tenantId,
        eventType: event.eventType,
        actorSub: event.actorSub ?? null,
        ip: event.ip ?? null,
        // Bound the client-controlled user-agent so a hostile client can't bloat the row.
        userAgent: event.userAgent ? event.userAgent.slice(0, 512) : null,
        metadata,
      });
    });
  }
}
