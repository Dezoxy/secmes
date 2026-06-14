import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { schema, withRouting } from '../db/index.js';

/**
 * Idempotency log for Stripe webhook events, backed by the global no-RLS `stripe_events` table (migration
 * 0029). Stripe delivers events at-least-once.
 *
 * The webhook records an event id as processed ONLY after its handler succeeds (`isProcessed` gate up front,
 * `markProcessed` after dispatch). So a crash/throw mid-handler leaves the event unrecorded and Stripe's
 * retry re-processes it — an event is never marked done without being done (at-least-once; no silent loss).
 * Handlers are idempotent, so a redelivery before the mark just repeats harmless work.
 *
 * Runs under `withRouting` (role argus_app, no tenant context) — stripe_events carries no tenant_id and no
 * content, only the event id/type/timestamp.
 */
@Injectable()
export class StripeEventStore {
  /** True if this event id has already been recorded as fully processed. */
  async isProcessed(eventId: string): Promise<boolean> {
    return withRouting(async (tx) => {
      const rows = await tx
        .select({ eventId: schema.stripeEvents.eventId })
        .from(schema.stripeEvents)
        .where(eq(schema.stripeEvents.eventId, eventId))
        .limit(1);
      return rows.length > 0;
    });
  }

  /**
   * Record an event id as processed. Call ONLY after the handler completes successfully. `ON CONFLICT DO
   * NOTHING` makes it safe under a race (two concurrent first-deliveries both mark — harmless).
   */
  async markProcessed(eventId: string, type: string): Promise<void> {
    await withRouting((tx) =>
      tx.insert(schema.stripeEvents).values({ eventId, type }).onConflictDoNothing(),
    );
  }
}
