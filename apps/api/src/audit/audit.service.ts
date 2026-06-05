import { Injectable } from '@nestjs/common';

import { schema, withTenant } from '../db/index.js';

export interface AuditEventInput {
  eventType: string;
  /** Verified OIDC subject (an identifier — never a token). */
  actorSub?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// NOTE: the `metadata` jsonb column exists for future structured context, but the service does
// NOT accept arbitrary metadata — that would put the "no secrets/content in the log" invariant on
// a caller's discipline. When a concrete need arises, add it behind a STRICT @argus/contracts Zod
// schema (closed object of known non-sensitive keys), validated here before insert.

@Injectable()
export class AuditService {
  /** Append one audit row inside the verified tenant's RLS context. IDs + metadata only. */
  async record(tenantId: string, event: AuditEventInput): Promise<void> {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(schema.auditEvents).values({
        tenantId,
        eventType: event.eventType,
        actorSub: event.actorSub ?? null,
        ip: event.ip ?? null,
        // Bound the client-controlled user-agent so a hostile client can't bloat the row.
        userAgent: event.userAgent ? event.userAgent.slice(0, 512) : null,
      });
    });
  }
}
