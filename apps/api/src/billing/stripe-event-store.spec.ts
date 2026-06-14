import { afterAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/index.js';
import { StripeEventStore } from './stripe-event-store.js';

// Integration test — exercises the REAL stripe_events grants as the argus_app role (isProcessed/markProcessed
// run inside withRouting → SET ROLE argus_app). The unit suite mocks StripeEventStore, so only this test would
// catch a missing INSERT/SELECT grant in migration 0029. Requires a live Postgres with migrations applied:
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

    it('isProcessed is false for a new event, true after markProcessed, and markProcessed is idempotent', async () => {
      expect(await store.isProcessed(EVENT_ID)).toBe(false); // SELECT grant — new event
      await store.markProcessed(EVENT_ID, 'test.event'); // INSERT grant — record after successful dispatch
      expect(await store.isProcessed(EVENT_ID)).toBe(true); // dedup gate now trips
      await store.markProcessed(EVENT_ID, 'test.event'); // ON CONFLICT DO NOTHING — safe under a race, no throw
      expect(await store.isProcessed(EVENT_ID)).toBe(true);
    });
  },
);
