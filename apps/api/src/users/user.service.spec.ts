import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { HANDLE_ADJECTIVES, HANDLE_ANIMALS } from './handle-words.js';
import { UserService } from './user.service.js';

/** Assert a value is a valid generated "Adjective Animal" handle (both words from the curated lists). */
function expectValidHandle(handle: string | null): void {
  expect(handle).toBeTruthy();
  const parts = (handle ?? '').split(' ');
  expect(parts).toHaveLength(2);
  expect(HANDLE_ADJECTIVES as readonly string[]).toContain(parts[0]);
  expect(HANDLE_ANIMALS as readonly string[]).toContain(parts[1]);
}

// Integration — JIT provisioning under RLS (roadmap 15). Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('UserService (JIT provisioning)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const users = new UserService();

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Prov-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Prov-B') returning id`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`;
      await sql.end({ timeout: 5 });
    }
  });

  it('provisions a new user with a generated pseudonymous handle (NOT the IdP name)', async () => {
    const auth: VerifiedAuth = {
      sub: 'sub-new',
      tenantId: tenantA,
      email: 'new@a.test',
      name: 'Real McName', // IdP name claim — must NOT become the display name
    };
    const created = await users.provisionFromToken(auth);
    expect(created.displayName).not.toBe('Real McName'); // no real-name leak
    expectValidHandle(created.displayName); // a random "Adjective Animal"
    expect((await users.getByAuth(auth))?.id).toBe(created.id);
  });

  it('keeps the handle on repeat login (same row, stable handle)', async () => {
    const first = await users.provisionFromToken({
      sub: 'sub-rep',
      tenantId: tenantA,
      email: 'rep@a.test',
      name: 'First',
    });
    const second = await users.provisionFromToken({
      sub: 'sub-rep',
      tenantId: tenantA,
      email: 'rep2@a.test',
      name: 'Second',
    });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(second.displayName).toBe(first.displayName); // handle is STABLE, never overwritten
  });

  it('allows two users with the same display name (no longer unique per tenant)', async () => {
    // Display names are free nicknames since 0038 dropped the unique index.
    const sameName = 'Duplicate Name';
    const u1 = await users.provisionFromToken(
      { sub: 'sub-dup1', tenantId: tenantA, email: 'dup1@a.test' },
      () => sameName,
    );
    const u2 = await users.provisionFromToken(
      { sub: 'sub-dup2', tenantId: tenantA, email: 'dup2@a.test' },
      () => sameName,
    );
    expect(u1.displayName).toBe(sameName);
    expect(u2.displayName).toBe(sameName);
    expect(u1.id).not.toBe(u2.id); // distinct users
  });

  it('heals a legacy NULL display name to a generated handle on next login', async () => {
    // Simulate a pre-#44b row with no handle (owner conn bypasses RLS — like a row NULLed by 0016's backfill).
    await sql`insert into users (tenant_id, external_identity_id, email, display_name)
              values (${tenantA}, 'sub-legacy-null', 'legacy@a.test', null)`;
    const healed = await users.provisionFromToken({
      sub: 'sub-legacy-null',
      tenantId: tenantA,
      email: 'legacy@a.test',
    });
    expectValidHandle(healed.displayName); // NULL coalesced to a fresh handle
  });

  it('rejects provisioning without a verified email claim', async () => {
    await expect(
      users.provisionFromToken({ sub: 'no-email', tenantId: tenantA }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is tenant-isolated — the same sub in two tenants yields two distinct rows', async () => {
    const a = await users.provisionFromToken({
      sub: 'shared',
      tenantId: tenantA,
      email: 's@a.test',
    });
    const b = await users.provisionFromToken({
      sub: 'shared',
      tenantId: tenantB,
      email: 's@b.test',
    });
    expect(a.id).not.toBe(b.id);
    expect((await users.getByAuth({ sub: 'shared', tenantId: tenantA }))?.id).toBe(a.id);
  });
});
