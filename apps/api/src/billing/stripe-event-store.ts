import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { schema, withRouting } from '../db/index.js';

/**
 * Idempotency log for Stripe webhook events, backed by the global no-RLS `stripe_events` table (migration
 * 0029). Stripe delivers events at-least-once; `claim()` records the event id and reports whether this is the
 * FIRST time we've seen it.
 *
 * Runs under `withRouting` (role argus_app, no tenant context) because stripe_events is a global table — it
 * carries no tenant_id and no content, only the event id/type/timestamp.
 */
@Injectable()
export class StripeEventStore {
  /**
   * Record `eventId`. Returns `true` if it was newly inserted (process the event), `false` if it was already
   * present (a Stripe redelivery → skip). The INSERT … ON CONFLICT DO NOTHING is atomic, so concurrent
   * deliveries of the same event resolve to exactly one `true`.
   */
  async claim(eventId: string, type: string): Promise<boolean> {
    return withRouting(async (tx) => {
      const inserted = await tx
        .insert(schema.stripeEvents)
        .values({ eventId, type })
        .onConflictDoNothing()
        .returning({ eventId: schema.stripeEvents.eventId });
      return inserted.length > 0;
    });
  }

  /**
   * Release a previously-claimed event id. Called when handling THROWS after `claim()` committed, so that
   * Stripe's at-least-once retry can re-process the event — without this, the dedup would suppress the retry
   * and a transient mid-handler fault would permanently lose the plan write. (Claim-first keeps the dedup
   * atomic against concurrent redelivery; release-on-failure keeps it retry-safe.)
   */
  async release(eventId: string): Promise<void> {
    await withRouting((tx) =>
      tx.delete(schema.stripeEvents).where(eq(schema.stripeEvents.eventId, eventId)),
    );
  }
}
