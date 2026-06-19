import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { AdminGuard } from './admin.guard.js';
import type { VerifiedAuth } from './auth.service.js';
import { BreakglassController } from './breakglass.controller.js';
import type { BreakglassService } from './breakglass.service.js';
import { CfAccessGuard } from './cf-access.guard.js';
import { COOKIE_NAME } from './session-token.service.js';

// Contract tier: login is @Public (emergency access) but still fronted by the class-level CfAccessGuard;
// rotate stays authenticated and adds AdminGuard on top. Behaviour tier: rotate's hard requirement that
// the caller holds an Argus-minted (breakglass) session — an OIDC token with no userId is forbidden.

function makeController() {
  const svc = {
    login: vi.fn().mockResolvedValue({
      accessToken: 'bg.access',
      refreshToken: 'bg.refresh',
      expiresAt: new Date(Date.now() + 60_000),
    }),
    rotate: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new BreakglassController(svc as unknown as BreakglassService), svc };
}

const guardNames = (method: string) =>
  reflectRouteMeta(BreakglassController, method)
    .guards.map((g) => g.name)
    .sort();
function fakeReq() {
  return { headers: { 'user-agent': 'vitest' } } as never;
}
function fakeRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn() };
}

describe('BreakglassController route contract', () => {
  it('login is public + rate-limited + 200, fronted by CfAccessGuard', () => {
    expect(reflectRouteMeta(BreakglassController, 'login')).toMatchObject({
      isPublic: true,
      isAllowUnbound: true,
      hasPublicRateLimit: true,
      httpCode: 200,
    });
    expect(guardNames('login')).toEqual([CfAccessGuard.name]);
  });

  it('rotate is authenticated + 204, behind CfAccessGuard AND AdminGuard', () => {
    expect(reflectRouteMeta(BreakglassController, 'rotate')).toMatchObject({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 204,
    });
    expect(guardNames('rotate')).toEqual([AdminGuard.name, CfAccessGuard.name].sort());
  });
});

describe('BreakglassController.login', () => {
  it('delegates to the service and sets a HttpOnly/Secure/Strict refresh cookie', async () => {
    const { controller, svc } = makeController();
    const res = fakeRes();
    await expect(
      controller.login(
        { username: 'root', password: 'pw' },
        res as never,
        fakeReq(),
        '203.0.113.1',
      ),
    ).resolves.toEqual({ accessToken: 'bg.access' });
    expect(svc.login).toHaveBeenCalledWith(
      'root',
      'pw',
      expect.objectContaining({ ip: '203.0.113.1' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'bg.refresh',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
  });
});

describe('BreakglassController.rotate — breakglass-session-only gate', () => {
  it('forbids a caller with no Argus userId (e.g. an OIDC admin token)', async () => {
    const { controller, svc } = makeController();
    const oidcAuth: VerifiedAuth = { sub: 'oidc:x', tenantId: 'tenant-1' };
    await expect(
      controller.rotate(
        { currentPassword: 'a', newPassword: 'b'.repeat(12) },
        oidcAuth,
        fakeRes() as never,
        fakeReq(),
        '203.0.113.1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.rotate).not.toHaveBeenCalled();
  });

  it('rotates and clears the cookie for a real breakglass session', async () => {
    const { controller, svc } = makeController();
    const bgAuth: VerifiedAuth = { sub: 'argusid:bg', tenantId: 'tenant-1', userId: 'u-bg' };
    const res = fakeRes();
    await controller.rotate(
      { currentPassword: 'a', newPassword: 'b'.repeat(12) },
      bgAuth,
      res as never,
      fakeReq(),
      '203.0.113.1',
    );
    expect(svc.rotate).toHaveBeenCalledWith('u-bg', 'a', 'b'.repeat(12), expect.any(Object));
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(Object));
  });
});
