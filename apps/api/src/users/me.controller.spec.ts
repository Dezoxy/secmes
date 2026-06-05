import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { MeController } from './me.controller.js';

// Integration — proves /me resolves the user inside the verified tenant's RLS context (13–14 → 15).
// Needs a live Postgres with migrations applied; auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('MeController.me', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const controller = new MeController();

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

  it('returns the user for a verified (tenant, sub)', async () => {
    const auth: VerifiedAuth = { sub: 'oidc-sub-a', tenantId: tenantA };
    const res = await controller.me(auth);
    expect(res).toEqual({
      userId: expect.any(String),
      tenantId: tenantA,
      email: 'a@a.test',
      displayName: 'Alice',
    });
  });

  it("cannot resolve another tenant's user even with a real sub (RLS scopes the lookup)", async () => {
    // tenant A context but B's sub → invisible under RLS → 404, never B's row.
    const auth: VerifiedAuth = { sub: 'oidc-sub-b', tenantId: tenantA };
    await expect(controller.me(auth)).rejects.toBeInstanceOf(NotFoundException);
  });
});
