import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself enforces the message-retention prune BOUNDARY (Track 4
// slice 3, migration 0044). The dedicated argus_msg_prune role may SELECT + DELETE ONLY messages past the
// 90-day ceiling — across tenants, but never an in-window row — and may read ONLY (id, created_at), never
// the ciphertext (invariant #1, the crypto-blind server). The app role's tenant isolation on `messages` is
// unchanged by the policy re-scope. Mirrors audit-prune-rls.spec.ts / friendships-rls.spec.ts. Requires a
// live Postgres with migrations applied:  make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
//
// Window: messages prune created_at < now() - 90 days. We assert on specific seeded row ids (contain /
// not-contain), never on cross-tenant counts, so other suites' rows can't perturb the result. NO deletion
// worker ships in this slice — this spec is the proof the boundary is correct before slice 4 adds one.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)(
  'message-retention prune boundary (argus_msg_prune) — Track 4 slice 3',
  () => {
    let sql: ReturnType<typeof getDb>['sql'];
    let tenantA: string;
    let tenantB: string;
    let convA: string;
    let convB: string;
    let userA: string;
    let userB: string;
    let seq = 0;

    // The app's withTenant(): non-bypass role + tx-local tenant context.
    function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
      return sql.begin(async (tx) => {
        await tx`set local role argus_app`;
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx as unknown as typeof sql);
      }) as Promise<unknown>;
    }

    // The prune worker's posture: the dedicated argus_msg_prune role, NO app.tenant_id set — it sweeps ACROSS
    // tenants, and its RLS policies expose + allow DELETE on ONLY past-window rows. This GUC-UNSET path must
    // SUCCEED (not throw): the 0044 re-scope removed the throwing isolation policy from this role (§7 cond 1a).
    function asMsgPrune(fn: (tx: typeof sql) => unknown): Promise<unknown> {
      return sql.begin(async (tx) => {
        await tx`set local role argus_msg_prune`;
        return fn(tx as unknown as typeof sql);
      }) as Promise<unknown>;
    }

    // Adversarial posture: argus_msg_prune that ALSO sets app.tenant_id to a real tenant. A leaked/misused
    // prune credential could do this; the isolation policy must NOT then OR-in and expose that tenant's
    // in-window ciphertext (the #262 bypass closed by scoping the 0007 isolation policy TO argus_app in 0044).
    function asMsgPruneWithTenant(
      tenantId: string,
      fn: (tx: typeof sql) => unknown,
    ): Promise<unknown> {
      return sql.begin(async (tx) => {
        await tx`set local role argus_msg_prune`;
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx as unknown as typeof sql);
      }) as Promise<unknown>;
    }

    // Owner inserts (superuser bypasses RLS). `ageDays` > 0 means created that many days in the PAST.
    // client_message_id is unique per (tenant, sender, cmid) → gen_random_uuid() avoids the idempotency index.
    function mkMessage(
      tenant: string,
      conversation: string,
      sender: string,
      ageDays: number,
    ): Promise<string> {
      seq += 1;
      return sql`insert into messages
                 (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch, created_at)
               values
                 (${tenant}, ${conversation}, ${sender}, gen_random_uuid(),
                  ${`ct-${seq}`}, 'MLS_1.0', 0, now() - make_interval(days => ${ageDays}))
               returning id`.then((rows) => (rows[0] as { id: string }).id);
    }

    const countMessage = async (id: string): Promise<number> =>
      ((await sql`select count(*)::int as n from messages where id = ${id}`)[0] as { n: number }).n;

    beforeAll(async () => {
      sql = getDb().sql;
      [{ id: tenantA }] =
        await sql`insert into tenants (name) values ('Msg Prune RLS A') returning id`;
      [{ id: tenantB }] =
        await sql`insert into tenants (name) values ('Msg Prune RLS B') returning id`;
      const mkUser = async (tenant: string, ext: string): Promise<string> => {
        const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                            values (${tenant}, ${ext}, ${`${ext}@t.test`}) returning id`;
        return (u as { id: string }).id;
      };
      userA = await mkUser(tenantA, 'msg-prune-a1');
      userB = await mkUser(tenantB, 'msg-prune-b1');
      const mkConv = async (tenant: string, creator: string): Promise<string> => {
        const [c] = await sql`insert into conversations (tenant_id, created_by)
                            values (${tenant}, ${creator}) returning id`;
        return (c as { id: string }).id;
      };
      convA = await mkConv(tenantA, userA);
      convB = await mkConv(tenantB, userB);
    });

    beforeEach(async () => {
      await sql`delete from messages where tenant_id in (${tenantA}, ${tenantB})`;
    });

    afterAll(async () => {
      if (sql) {
        await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades convs + messages
        await sql.end({ timeout: 5 });
      }
    });

    it('argus_msg_prune (GUC unset) sees only past-window messages, across tenants — sweep SUCCEEDS', async () => {
      // §7 cond 1a: the prune role's NORMAL no-GUC sweep must SUCCEED, not throw. If the isolation policy were
      // still PUBLIC + throwing, this very SELECT would error (the silent-prod-failure this test guards).
      const oldA = await mkMessage(tenantA, convA, userA, 100); // > 90d → prunable
      const recentA = await mkMessage(tenantA, convA, userA, 10); // < 90d → in-window
      const oldB = await mkMessage(tenantB, convB, userB, 100); // other tenant, > 90d → prunable

      const seen = (await asMsgPrune((tx) => tx`select id from messages`)) as Array<{ id: string }>;
      const ids = seen.map((r) => r.id);
      expect(ids).toContain(oldA);
      expect(ids).toContain(oldB); // cross-tenant — no app.tenant_id set
      expect(ids).not.toContain(recentA); // in-window row invisible to the prune role
    });

    it('argus_msg_prune deletes past-window messages of both tenants but cannot touch an in-window one', async () => {
      const oldA = await mkMessage(tenantA, convA, userA, 100);
      const recentA = await mkMessage(tenantA, convA, userA, 10);
      const oldB = await mkMessage(tenantB, convB, userB, 100);

      await asMsgPrune((tx) => tx`delete from messages where id = ${oldA}`); // reaped
      await asMsgPrune((tx) => tx`delete from messages where id = ${oldB}`); // reaped (cross-tenant)
      await asMsgPrune((tx) => tx`delete from messages where id = ${recentA}`); // RLS hides it → 0 rows

      expect(await countMessage(oldA)).toBe(0);
      expect(await countMessage(oldB)).toBe(0);
      expect(await countMessage(recentA)).toBe(1); // in-window row survived — prune could not see it
    });

    it('argus_msg_prune setting app.tenant_id CANNOT reach a tenant’s in-window messages (#262)', async () => {
      // The bypass this guards: if messages_tenant_isolation were still PUBLIC/FOR ALL, an argus_msg_prune
      // session that sets app.tenant_id would OR the isolation predicate in and expose that tenant's LIVE
      // ciphertext. After scoping it TO argus_app (0044), the isolation policy doesn't apply to argus_msg_prune
      // at all — only the past-window prune policies do — so setting app.tenant_id buys nothing.
      const liveA = await mkMessage(tenantA, convA, userA, 10); // in-window → must stay invisible/undeletable

      const seen = (await asMsgPruneWithTenant(
        tenantA,
        (tx) => tx`select id from messages`,
      )) as Array<{ id: string }>;
      expect(seen.map((r) => r.id)).not.toContain(liveA);

      await asMsgPruneWithTenant(tenantA, (tx) => tx`delete from messages where id = ${liveA}`);
      expect(await countMessage(liveA)).toBe(1); // live message survived — no bypass
    });

    it('argus_app tenant isolation on messages is unchanged by the policy re-scope', async () => {
      await mkMessage(tenantA, convA, userA, 1);
      await mkMessage(tenantB, convB, userB, 1);
      const seen = (await asTenant(tenantA, (tx) => tx`select tenant_id from messages`)) as Array<{
        tenant_id: string;
      }>;
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.every((r) => r.tenant_id === tenantA)).toBe(true); // B's rows invisible to A
    });

    it('argus_msg_prune cannot read ciphertext — column-scoped grant excludes content (invariant #1)', async () => {
      await mkMessage(tenantA, convA, userA, 100); // a past-window row the prune role CAN see (by id)
      // The grant is SELECT (id, created_at) only; selecting ciphertext is a column-privilege denial — it
      // throws on privilege BEFORE any row filtering, so this holds regardless of which rows exist.
      await expect(asMsgPrune((tx) => tx`select ciphertext from messages`)).rejects.toThrow();
      // The allowed metadata columns still work — proves the denial is column-scoped, not a blanket block.
      await expect(
        asMsgPrune((tx) => tx`select id, created_at from messages`),
      ).resolves.toBeDefined();
    });
  },
);
