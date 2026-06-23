import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { AdminController } from './admin.controller.js';
import type { AdminService } from './admin.service.js';

// Admin surface — the contract tier pins that every route sits behind AdminGuard (Argus JWT +
// session revocation + role='admin'). CF Access is NOT on the admin API — it would block regular
// admin users accessing the in-app settings panel without having gone through the breakglass flow.
// The behaviour tier is thin delegation (metadata-only shaping lives in AdminService).

const auth: VerifiedAuth = {
  sub: 'argusid:admin',
  tenantId: '11111111-1111-1111-1111-111111111111',
};

function makeController() {
  const svc = {
    listDevices: vi.fn().mockResolvedValue([]),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
    listAudit: vi.fn().mockResolvedValue({ events: [] }),
  };
  return { controller: new AdminController(svc as unknown as AdminService), svc };
}

const guardNames = (method: string) =>
  reflectRouteMeta(AdminController, method)
    .guards.map((g) => g.name)
    .sort();

describe('AdminController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['listDevices', 200],
    ['revokeDevice', 204],
    ['listAudit', 200],
  ];

  it.each(ROUTES)('%s is non-public with the expected status code', (method, httpCode) => {
    const meta = reflectRouteMeta(AdminController, method);
    expect(meta).toMatchObject({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
    });
  });

  it.each(['listDevices', 'revokeDevice', 'listAudit'])(
    '%s is wrapped by AdminGuard only (no CfAccessGuard — admin API is not behind CF Access)',
    (method) => {
      expect(guardNames(method)).toEqual([AdminGuard.name]);
    },
  );
});

describe('AdminController delegation', () => {
  it('listDevices forwards the verified auth', async () => {
    const { controller, svc } = makeController();
    await controller.listDevices(auth);
    expect(svc.listDevices).toHaveBeenCalledWith(auth);
  });

  it('revokeDevice forwards auth + the device id', async () => {
    const { controller, svc } = makeController();
    await controller.revokeDevice(auth, 'dev-1');
    expect(svc.revokeDevice).toHaveBeenCalledWith(auth, 'dev-1');
  });

  it('listAudit forwards auth + limit + cursor', async () => {
    const { controller, svc } = makeController();
    await controller.listAudit(auth, 25, 'cur');
    expect(svc.listAudit).toHaveBeenCalledWith(auth, 25, 'cur');
  });
});
