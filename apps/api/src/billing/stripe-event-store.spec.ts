import { afterAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/index.js';
import { StripeEventStore } from './stripe-event-store.js';

// Integration test — exercises the REAL stripe_events grants as the argus_app role (claim/release run inside
// withRouting → SET ROLE argus_app). The unit suite mocks StripeEventStore, so only this test would catch a
// missing INSERT/SELECT/DELETE grant in migration 0029. Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job has no DB service).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)(
  'StripeEventStore (integration: stripe_events grants as argus_app)',
  () => {
    const store = new StripeEventStore();
    const EVENT_ID = 'evt_store_spec_test';

    afterAll(async () => {
      const { sql } = getDb();
      await sql`delete from stripe_events where event_id = ${EVENT_ID}`; // cleanup as the owner connection
      await sql.end({ timeout: 5 });
    });

    it('claim is true for a new event, false on redelivery, and release (DELETE grant) makes it claimable again', async () => {
      expect(await store.claim(EVENT_ID, 'test.event')).toBe(true); // INSERT grant — first delivery
      expect(await store.claim(EVENT_ID, 'test.event')).toBe(false); // SELECT/conflict — redelivery deduped
      await store.release(EVENT_ID); // DELETE grant — the release-on-failure path
      expect(await store.claim(EVENT_ID, 'test.event')).toBe(true); // re-claimable, so Stripe's retry re-processes
    });
  },
);
