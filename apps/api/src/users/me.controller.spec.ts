import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';

// Integration — proves /me resolves the user inside the verified tenant's RLS context (13–14 → 15).
// Needs a live Postgres with migrations applied; auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('MeController.me', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const controller = new MeController(new UserService());

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Me-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Me-B') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email, display_name)
              values (${tenantA}, 'oidc-sub-a', 'a@a.test', 'Alice')`;
    await sql`insert into users (tenant_id, external_identity_id, email)
              values (${tenantB}, 'oidc-sub-b', 'b@b.test')`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`;
      await sql.end({ timeout: 5 });
    }
  });

  it('returns the bound user with all fields for a verified (tenant, sub)', async () => {
    const auth: VerifiedAuth = { sub: 'oidc-sub-a', tenantId: tenantA };
    const res = await controller.me(auth);
    expect(res).toEqual({
      bound: true,
      userId: expect.any(String),
      tenantId: tenantA,
      argusId: expect.stringMatching(/^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/),
      email: 'a@a.test',
      displayName: 'Alice',
      role: 'member',
      plan: {
        tier: 'free',
        memberLimit: 10,
        ssoEnabled: false,
        memberCount: expect.any(Number),
        subscriptionStatus: null,
      },
    });
  });

  it("returns { bound: false } for another tenant's sub (RLS scopes the lookup)", async () => {
    // tenant A context but B's sub → invisible under RLS → unbound, never B's row.
    const auth: VerifiedAuth = { sub: 'oidc-sub-b', tenantId: tenantA };
    const res = await controller.me(auth);
    expect(res).toEqual({ bound: false });
  });
});
