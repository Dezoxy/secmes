import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { UserService } from '../users/user.service.js';
import { FriendsService } from './friends.service.js';

// Integration test — exercises the real FriendsService against a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job). Proves the canonical-pair collapse,
// the uniform-202 create path, and (critically) the WHERE-clause IDOR predicates on every mutation.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('FriendsService (Slice D — friends API)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let service: FriendsService;
  let tenant: string;
  let userA: string;
  let userB: string;
  let userC: string;
  const argusA = 'argus-abcdefghjkmnpqrs-aaa';
  const argusB = 'argus-bcdefghjkmnpqrst-bbb';
  const argusC = 'argus-cdefghjkmnpqrstu-ccc';

  function authFor(userId: string, sub: string): VerifiedAuth {
    return { sub, tenantId: tenant, userId };
  }

  // Count friendship rows for the seeded tenant (owner connection bypasses RLS — read-only assertion).
  async function rowCount(): Promise<number> {
    const [r] = await sql`select count(*)::int as n from friendships where tenant_id = ${tenant}`;
    return (r as { n: number }).n;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenant }] = await sql`insert into tenants (name) values ('Friends Tenant') returning id`;
    [{ id: userA }] = await sql`insert into users (tenant_id, external_identity_id, argus_id, email)
      values (${tenant}, 'fr-ext-a', ${argusA}, 'fr-a@a.test') returning id`;
    [{ id: userB }] = await sql`insert into users (tenant_id, external_identity_id, argus_id, email)
      values (${tenant}, 'fr-ext-b', ${argusB}, 'fr-b@b.test') returning id`;
    [{ id: userC }] = await sql`insert into users (tenant_id, external_identity_id, argus_id, email)
      values (${tenant}, 'fr-ext-c', ${argusC}, 'fr-c@c.test') returning id`;
    service = new FriendsService(new UserService());
  });

  beforeEach(async () => {
    await sql`delete from friendships where tenant_id = ${tenant}`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id = ${tenant}`; // cascades users + friendships
      await sql.end({ timeout: 5 });
    }
  });

  describe('sendRequest (uniform 202 path)', () => {
    it('creates exactly one pending row and collapses the reciprocal request to a no-op', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');

      const r1 = await service.sendRequest(a, argusB);
      expect(r1.targetFound).toBe(true);
      expect(await rowCount()).toBe(1);

      // B requesting A back hits the same canonical pair → ON CONFLICT DO NOTHING, still one row.
      const r2 = await service.sendRequest(b, argusA);
      expect(r2.targetFound).toBe(true);
      expect(await rowCount()).toBe(1);

      // The single row is pending, opened by A, with a future expiry.
      const [row] = await sql`select status, requested_by, expires_at from friendships
        where tenant_id = ${tenant}`;
      expect((row as { status: string }).status).toBe('pending');
      expect((row as { requested_by: string }).requested_by).toBe(userA);
      expect((row as { expires_at: Date }).expires_at).toBeTruthy();
    });

    it('reports targetFound=false and writes no row for an unknown argus-id', async () => {
      const r = await service.sendRequest(
        authFor(userA, 'fr-ext-a'),
        'argus-zzzzzzzzzzzzzzzz-nope',
      );
      expect(r.targetFound).toBe(false);
      expect(await rowCount()).toBe(0);
    });

    it('rejects a self-request silently (no row)', async () => {
      const r = await service.sendRequest(authFor(userA, 'fr-ext-a'), argusA);
      expect(r.targetFound).toBe(true); // the lookup found the user…
      expect(await rowCount()).toBe(0); // …but no self-friendship row is written
    });

    it('rejects a revoked caller BEFORE the target branch (no active-user oracle)', async () => {
      // Soft-delete userC, then have them send to an EXISTING target (B) and a NON-EXISTENT target.
      // Both must fail the same way (caller-active gate throws) — no 202-vs-400 split that would leak
      // whether the target exists.
      await sql`update users set status = 'suspended' where id = ${userC}`;
      try {
        const revoked = authFor(userC, 'fr-ext-c');
        await expect(service.sendRequest(revoked, argusB)).rejects.toThrow();
        await expect(service.sendRequest(revoked, 'argus-zzzzzzzzzzzzzzzz-nope')).rejects.toThrow();
        expect(await rowCount()).toBe(0);
      } finally {
        await sql`update users set status = 'active' where id = ${userC}`;
      }
    });
  });

  describe('listRequests direction split', () => {
    it('shows the request as outgoing for the requester and incoming for the recipient', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      await service.sendRequest(a, argusB);

      const aOutgoing = await service.listRequests(a, 'outgoing');
      expect(aOutgoing).toHaveLength(1);
      expect(aOutgoing[0]?.userId).toBe(userB);
      expect(aOutgoing[0]?.direction).toBe('outgoing');
      expect(await service.listRequests(a, 'incoming')).toHaveLength(0);

      const bIncoming = await service.listRequests(b, 'incoming');
      expect(bIncoming).toHaveLength(1);
      expect(bIncoming[0]?.userId).toBe(userA);
      expect(bIncoming[0]?.direction).toBe('incoming');
      expect(await service.listRequests(b, 'outgoing')).toHaveLength(0);
    });
  });

  describe('accept (recipient-only IDOR gate)', () => {
    it('lets the recipient accept — clears requested_by/expires_at, sets resolved_at', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(b, 'incoming');

      await service.accept(b, req!.requestId);

      const [row] = await sql`select status, requested_by, expires_at, resolved_at from friendships
        where tenant_id = ${tenant}`;
      expect((row as { status: string }).status).toBe('accepted');
      expect((row as { requested_by: string | null }).requested_by).toBeNull();
      expect((row as { expires_at: Date | null }).expires_at).toBeNull();
      expect((row as { resolved_at: Date | null }).resolved_at).toBeTruthy();
    });

    it('404s when the REQUESTER tries to accept their own request (no self-accept)', async () => {
      const a = authFor(userA, 'fr-ext-a');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(a, 'outgoing');

      await expect(service.accept(a, req!.requestId)).rejects.toBeInstanceOf(NotFoundException);
      // Row is untouched — still pending.
      const [row] = await sql`select status from friendships where tenant_id = ${tenant}`;
      expect((row as { status: string }).status).toBe('pending');
    });

    it('404s when an unrelated third party tries to accept', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const c = authFor(userC, 'fr-ext-c');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(authFor(userB, 'fr-ext-b'), 'incoming');

      await expect(service.accept(c, req!.requestId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('decline / cancel (hard delete + role predicates)', () => {
    it('lets the recipient decline (hard delete)', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(b, 'incoming');

      await service.decline(b, req!.requestId);
      expect(await rowCount()).toBe(0);
    });

    it('lets the requester cancel (hard delete) but 404s if the recipient tries to cancel', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(a, 'outgoing');

      // Recipient cannot cancel (cancel is requester-only).
      await expect(service.cancel(b, req!.requestId)).rejects.toBeInstanceOf(NotFoundException);
      expect(await rowCount()).toBe(1);

      // Requester can.
      await service.cancel(a, req!.requestId);
      expect(await rowCount()).toBe(0);
    });
  });

  describe('TTL enforced at the API layer (before the sweep runs)', () => {
    it('hides and rejects an expired pending request', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      // Seed an already-expired pending request (canonical pair, A as requester) directly — simulates a
      // row the cleanup sweep has not yet reaped.
      const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
      const [seeded] = await sql`insert into friendships
        (tenant_id, user_low_id, user_high_id, status, requested_by, expires_at)
        values (${tenant}, ${low}, ${high}, 'pending', ${userA}, now() - interval '1 day')
        returning id`;
      const expiredId = (seeded as { id: string }).id;

      // Invisible in both boxes…
      expect(await service.listRequests(b, 'incoming')).toHaveLength(0);
      expect(await service.listRequests(a, 'outgoing')).toHaveLength(0);
      // …and inert to accept / decline / cancel.
      await expect(service.accept(b, expiredId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.decline(b, expiredId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.cancel(a, expiredId)).rejects.toBeInstanceOf(NotFoundException);
      // The row is still present (only the sweep deletes it) but unusable.
      expect(await rowCount()).toBe(1);
    });
  });

  describe('listFriends + unfriend', () => {
    it('returns accepted friends with the other party profile, then unfriends', async () => {
      const a = authFor(userA, 'fr-ext-a');
      const b = authFor(userB, 'fr-ext-b');
      await service.sendRequest(a, argusB);
      const [req] = await service.listRequests(b, 'incoming');
      await service.accept(b, req!.requestId);

      const aFriends = await service.listFriends(a);
      expect(aFriends).toHaveLength(1);
      expect(aFriends[0]?.userId).toBe(userB);
      expect(aFriends[0]?.argusId).toBe(argusB);
      expect(aFriends[0]?.since).toBeTruthy();

      // The friendship is symmetric — B sees A too.
      const bFriends = await service.listFriends(b);
      expect(bFriends[0]?.userId).toBe(userA);

      await service.unfriend(a, userB);
      expect(await rowCount()).toBe(0);
      expect(await service.listFriends(b)).toHaveLength(0);
    });

    it('404s when unfriending someone who is not an accepted friend', async () => {
      await expect(service.unfriend(authFor(userA, 'fr-ext-a'), userC)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
