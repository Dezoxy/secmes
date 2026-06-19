import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { TenantsController } from './tenants.controller.js';
import type { TenantsService } from './tenants.service.js';

// Contract tier — this is the load-bearing one for tenants: EVERY route is admin-only via @UseGuards(AdminGuard).
// A route here that lost its guard is a tenant-administration IDOR (any member could mint invites or change
// roles), so we assert the guard on all six. Status codes: createInvite=201 (mints a resource), the GETs=200,
// the mutating DELETE/PATCH=204. Behaviour tier: listInvites maps Date→ISO with null-safe accepted/revoked;
// the rest delegate faithfully.

const auth: VerifiedAuth = {
  sub: 'argusid:admin',
  tenantId: '11111111-1111-1111-1111-111111111111',
};
const INVITE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

function makeController() {
  const tenants = {
    createInvite: vi
      .fn()
      .mockResolvedValue({ inviteId: INVITE, token: 'tok', expiresAt: '2026-01-01T00:00:00.000Z' }),
    listInvites: vi.fn().mockResolvedValue([]),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    setMemberRole: vi.fn().mockResolvedValue(undefined),
    revokeMember: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new TenantsController(tenants as unknown as TenantsService), tenants };
}

const guardNames = (method: string) =>
  reflectRouteMeta(TenantsController, method).guards.map((g) => g.name);

describe('TenantsController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['createInvite', 201],
    ['listInvites', 200],
    ['revokeInvite', 204],
    ['listMembers', 200],
    ['setMemberRole', 204],
    ['revokeMember', 204],
  ];

  it.each(ROUTES)('%s is non-public with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(TenantsController, method)).toMatchObject({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
    });
  });

  it.each([
    'createInvite',
    'listInvites',
    'revokeInvite',
    'listMembers',
    'setMemberRole',
    'revokeMember',
  ])('%s is admin-only (AdminGuard)', (method) => {
    expect(guardNames(method)).toContain(AdminGuard.name);
  });
});

describe('TenantsController behaviour', () => {
  it('createInvite delegates to the service', async () => {
    const { controller, tenants } = makeController();
    const result = await controller.createInvite(auth);
    expect(tenants.createInvite).toHaveBeenCalledWith(auth);
    expect(result).toMatchObject({ inviteId: INVITE, token: 'tok' });
  });

  it('listInvites maps Date columns to ISO with null-safe accepted/revoked', async () => {
    const { controller, tenants } = makeController();
    tenants.listInvites.mockResolvedValue([
      {
        id: INVITE,
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date('2025-12-01T00:00:00.000Z'),
      },
      {
        id: 'i2',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        acceptedAt: new Date('2026-01-15T00:00:00.000Z'),
        revokedAt: new Date('2026-01-20T00:00:00.000Z'),
        createdAt: new Date('2025-12-15T00:00:00.000Z'),
      },
    ]);
    const rows = await controller.listInvites(auth);
    expect(rows).toEqual([
      {
        id: INVITE,
        expiresAt: '2026-01-01T00:00:00.000Z',
        acceptedAt: null,
        revokedAt: null,
        createdAt: '2025-12-01T00:00:00.000Z',
      },
      {
        id: 'i2',
        expiresAt: '2026-02-01T00:00:00.000Z',
        acceptedAt: '2026-01-15T00:00:00.000Z',
        revokedAt: '2026-01-20T00:00:00.000Z',
        createdAt: '2025-12-15T00:00:00.000Z',
      },
    ]);
  });

  it('revokeInvite forwards the invite id', async () => {
    const { controller, tenants } = makeController();
    await controller.revokeInvite(auth, INVITE);
    expect(tenants.revokeInvite).toHaveBeenCalledWith(auth, INVITE);
  });

  it('listMembers delegates to the service', async () => {
    const { controller, tenants } = makeController();
    await controller.listMembers(auth);
    expect(tenants.listMembers).toHaveBeenCalledWith(auth);
  });

  it('setMemberRole forwards the user id + role', async () => {
    const { controller, tenants } = makeController();
    await controller.setMemberRole(auth, USER, { role: 'admin' });
    expect(tenants.setMemberRole).toHaveBeenCalledWith(auth, USER, 'admin');
  });

  it('revokeMember forwards the user id', async () => {
    const { controller, tenants } = makeController();
    await controller.revokeMember(auth, USER);
    expect(tenants.revokeMember).toHaveBeenCalledWith(auth, USER);
  });
});
