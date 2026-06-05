import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { UserService } from './user.service.js';

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

  it('provisions a new user from verified claims, readable back via getByAuth', async () => {
    const auth: VerifiedAuth = {
      sub: 'sub-new',
      tenantId: tenantA,
      email: 'new@a.test',
      name: 'New User',
    };
    const created = await users.provisionFromToken(auth);
    expect(created).toEqual({
      id: expect.any(String),
      email: 'new@a.test',
      displayName: 'New User',
    });
    expect((await users.getByAuth(auth))?.id).toBe(created.id);
  });

  it('is idempotent and refreshes the profile on repeat (same row, updated name)', async () => {
    const first = await users.provisionFromToken({
      sub: 'sub-rep',
      tenantId: tenantA,
      email: 'rep@a.test',
      name: 'First',
    });
    const second = await users.provisionFromToken({
      sub: 'sub-rep',
      tenantId: tenantA,
      email: 'rep@a.test',
      name: 'Second',
    });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(second.displayName).toBe('Second'); // profile refreshed
  });

  it('does not blank a known display name when a later token omits the name claim', async () => {
    await users.provisionFromToken({
      sub: 'sub-keep',
      tenantId: tenantA,
      email: 'k@a.test',
      name: 'Keep Me',
    });
    const after = await users.provisionFromToken({
      sub: 'sub-keep',
      tenantId: tenantA,
      email: 'k@a.test',
    }); // no name claim this time
    expect(after.displayName).toBe('Keep Me');
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
    expect((await users.getByAuth({ sub: 'shared', tenantId: tenantA }))?.email).toBe('s@a.test');
  });

  it('lists only the tenant’s own users — ordered by email, bounded by limit', async () => {
    const all = await users.list(tenantA, 100);
    const emails = all.map((u) => u.email);
    expect(emails.length).toBeGreaterThanOrEqual(3); // provisioned above in tenant A
    expect([...emails].sort()).toEqual(emails); // already sorted ascending
    expect(emails).not.toContain('s@b.test'); // tenant B's user never leaks
    expect((await users.list(tenantA, 2)).length).toBe(2); // limit caps the result
  });

  it('excludes non-active users from the directory', async () => {
    const u = await users.provisionFromToken({
      sub: 'sub-suspended',
      tenantId: tenantA,
      email: 'zzz-suspended@a.test',
    });
    await sql`update users set status = 'suspended' where id = ${u.id}`; // owner conn, bypasses RLS
    const emails = (await users.list(tenantA, 100)).map((r) => r.email);
    expect(emails).not.toContain('zzz-suspended@a.test');
  });
});
