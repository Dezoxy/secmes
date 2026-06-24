import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { UpdatePrivacySettingsSchema, UpdateProfileSchema } from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { getDb } from '../db/index.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';

// Contract tier (DB-free): both routes are authenticated 'users' endpoints with no extra guards. The
// load-bearing distinction is @AllowUnbound — `me` is callable by an authenticated-but-not-yet-bound user
// (it returns { bound: false }), but `updateMe` is NOT, so a profile write always requires a bound tenant.
// `updateMe` is @HttpCode(204); `me` is a 200 GET.
describe('MeController route contract', () => {
  it('me is authenticated, allow-unbound, 200 GET, no guards', () => {
    expect(reflectRouteMeta(MeController, 'me')).toEqual({
      isPublic: false,
      isAllowUnbound: true,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [],
    });
  });

  it('updateMe is authenticated, NOT allow-unbound, 204, no guards', () => {
    expect(reflectRouteMeta(MeController, 'updateMe')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 204,
      guards: [],
    });
  });

  it('getMyPrivacySettings is authenticated, NOT allow-unbound, 200 GET, no guards', () => {
    expect(reflectRouteMeta(MeController, 'getMyPrivacySettings')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [],
    });
  });

  it('updateMyPrivacySettings is authenticated, NOT allow-unbound, 204, no guards', () => {
    expect(reflectRouteMeta(MeController, 'updateMyPrivacySettings')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 204,
      guards: [],
    });
  });
});

// Boundary behaviour (DB-free): PUT /me/settings/privacy body runs through ZodValidationPipe(UpdatePrivacySettingsSchema).
describe('updateMyPrivacySettings body validation (boundary)', () => {
  const pipe = new ZodValidationPipe(UpdatePrivacySettingsSchema);

  it('rejects non-boolean values', () => {
    expect(() => pipe.transform({ readReceipts: 'yes' })).toThrow();
    expect(() => pipe.transform({ typingIndicators: 1 })).toThrow();
  });

  it('rejects unknown fields (.strict())', () => {
    expect(() => pipe.transform({ readReceipts: true, unknown: 'field' })).toThrow();
  });

  it('accepts a partial update', () => {
    expect(pipe.transform({ readReceipts: false })).toEqual({ readReceipts: false });
  });

  it('accepts an empty body', () => {
    expect(pipe.transform({})).toEqual({});
  });
});

// Boundary behaviour (DB-free): the PUT /me body runs through ZodValidationPipe(UpdateProfileSchema),
// so a display name that violates the hardened policy is rejected (400) before the handler executes.
describe('updateMe body validation (boundary)', () => {
  const pipe = new ZodValidationPipe(UpdateProfileSchema);

  it('rejects names with disallowed (zero-width / over-length) characters', () => {
    expect(() => pipe.transform({ displayName: 'Bad\u200bName' })).toThrow();
    expect(() => pipe.transform({ displayName: 'A'.repeat(33) })).toThrow();
  });

  it('accepts and normalizes a valid name; an absent name is allowed', () => {
    expect(pipe.transform({ displayName: '  Brave   Otter  ' })).toEqual({
      displayName: 'Brave Otter',
    });
    expect(pipe.transform({})).toEqual({});
  });
});

// Integration — DB-backed tests. Auto-skip without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

// Uniqueness gate: two active users in the same tenant may not share a display name
// (case-insensitive). Cross-tenant and self-update are both allowed.
describe.skipIf(!DB_URL)('UserService.updateProfile uniqueness', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  const service = new UserService();

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Uniq-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Uniq-B') returning id`;
    [{ id: userA }] = await sql`insert into users (tenant_id, external_identity_id, display_name)
                values (${tenantA}, 'uniq-sub-a', 'BraveOtter') returning id`;
    [{ id: userB }] = await sql`insert into users (tenant_id, external_identity_id)
                values (${tenantA}, 'uniq-sub-b') returning id`;
  });

  afterAll(async () => {
    if (sql) {
      // Do NOT call sql.end() — the MeController.me block below owns the connection lifecycle.
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`;
    }
  });

  it('rejects a name already taken by another user (exact match)', async () => {
    await expect(
      service.updateProfile({ tenantId: tenantA, userId: userB }, { displayName: 'BraveOtter' }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a name already taken by another user (case-variant)', async () => {
    await expect(
      service.updateProfile({ tenantId: tenantA, userId: userB }, { displayName: 'braveotter' }),
    ).rejects.toThrow(ConflictException);
  });

  it('allows the same name in a different tenant', async () => {
    const rows = await sql<{ id: string }[]>`insert into users (tenant_id, external_identity_id)
                values (${tenantB}, 'uniq-sub-c') returning id`;
    const userC = rows[0]!.id;
    await expect(
      service.updateProfile({ tenantId: tenantB, userId: userC }, { displayName: 'BraveOtter' }),
    ).resolves.toBeUndefined();
  });

  it('allows a user to re-save their own current display name', async () => {
    await expect(
      service.updateProfile({ tenantId: tenantA, userId: userA }, { displayName: 'BraveOtter' }),
    ).resolves.toBeUndefined();
  });
});

// Proves /me resolves the user inside the verified tenant's RLS context (13–14 → 15).

describe.skipIf(!DB_URL)('MeController.me', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const controller = new MeController(new UserService(), new AuditService());

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
      displayName: 'Alice',
      avatarSeed: null,
      role: 'member',
      // Phase 6: /me no longer carries a billing plan or email. isBreakglass is undefined for normal
      // users → omitted by toEqual.
    });
  });

  it("returns { bound: false } for another tenant's sub (RLS scopes the lookup)", async () => {
    // tenant A context but B's sub → invisible under RLS → unbound, never B's row.
    const auth: VerifiedAuth = { sub: 'oidc-sub-b', tenantId: tenantA };
    const res = await controller.me(auth);
    expect(res).toEqual({ bound: false });
  });
});
