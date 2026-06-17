import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { schema, withTenant } from '../db/index.js';

export interface AuditEventInput {
  eventType: string;
  /** Verified OIDC subject (an identifier — never a token). */
  actorSub?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Structured non-sensitive metadata validated against a strict schema before insert. */
  metadata?: LookupUserMeta;
}

/**
 * Metadata for the `users.lookup` audit event.
 * Fields are pseudonymous identifiers + a boolean — no PII.
 */
export interface LookupUserMeta {
  targetArgusId: string;
  found: boolean;
}

const LookupUserMetaSchema = z.object({
  targetArgusId: z.string().max(128),
  found: z.boolean(),
});

@Injectable()
export class AuditService {
  /** Append one audit row inside the verified tenant's RLS context. IDs + metadata only. */
  async record(tenantId: string, event: AuditEventInput): Promise<void> {
    const metadata = event.metadata ? LookupUserMetaSchema.parse(event.metadata) : null;
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
