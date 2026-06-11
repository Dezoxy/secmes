import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthService, MaybeUnboundAuth, VerifiedAuth } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const BOUND_AUTH: MaybeUnboundAuth = {
  sub: 'u1',
  tenantId: '11111111-1111-1111-1111-111111111111',
};
const UNBOUND_AUTH: MaybeUnboundAuth = { sub: 'u2', tenantId: null };

function ctx(
  headers: Record<string, string | undefined>,
  type: 'http' | 'ws' = 'http',
): {
  req: { headers: Record<string, string | undefined>; auth?: VerifiedAuth };
  ec: ExecutionContext;
} {
  const req = { headers };
  const ec = {
    getType: () => type,
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, ec };
}

/** isPublic and isAllowUnbound are returned by reflector.getAllAndOverride in that order. */
function makeGuard(
  isPublic: boolean,
  isAllowUnbound = false,
  verify = vi.fn().mockResolvedValue(BOUND_AUTH),
): JwtAuthGuard {
  let callCount = 0;
  const reflector = {
    getAllAndOverride: () => {
      // First call: IS_PUBLIC_KEY. Second call: IS_ALLOW_UNBOUND_KEY.
      return callCount++ === 0 ? isPublic : isAllowUnbound;
    },
  } as unknown as Reflector;
  const auth = { verify } as unknown as AuthService;
  return new JwtAuthGuard(reflector, auth);
}

describe('JwtAuthGuard', () => {
  it('allows @Public routes without a token', async () => {
    const { ec } = ctx({});
    await expect(makeGuard(true).canActivate(ec)).resolves.toBe(true);
  });

  it('rejects a missing Authorization header', async () => {
    const { ec } = ctx({});
    await expect(makeGuard(false).canActivate(ec)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const { ec } = ctx({ authorization: 'Basic abc' });
    await expect(makeGuard(false).canActivate(ec)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verifies a Bearer token and attaches verified identity to the request', async () => {
    const verify = vi.fn().mockResolvedValue(BOUND_AUTH);
    const guard = makeGuard(false, false, verify);
    const { ec, req } = ctx({ authorization: 'Bearer good.token' });
    await expect(guard.canActivate(ec)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good.token');
    expect(req.auth).toMatchObject(BOUND_AUTH);
  });

  it('ignores a client-supplied X-Tenant-Id header (tenant comes from DB binding only)', async () => {
    const guard = makeGuard(false, false, vi.fn().mockResolvedValue(BOUND_AUTH));
    const { ec, req } = ctx({
      authorization: 'Bearer good.token',
      'x-tenant-id': '99999999-9999-9999-9999-999999999999', // attacker-supplied; must have no effect
    });
    await expect(guard.canActivate(ec)).resolves.toBe(true);
    expect(req.auth?.tenantId).toBe(BOUND_AUTH.tenantId); // the DB-derived binding, not the header
  });

  it('rejects an unbound user on a protected route with 403', async () => {
    const guard = makeGuard(false, false, vi.fn().mockResolvedValue(UNBOUND_AUTH));
    const { ec } = ctx({ authorization: 'Bearer unbound.token' });
    await expect(guard.canActivate(ec)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an unbound user on an @AllowUnbound route', async () => {
    const guard = makeGuard(false, true, vi.fn().mockResolvedValue(UNBOUND_AUTH));
    const { ec, req } = ctx({ authorization: 'Bearer unbound.token' });
    await expect(guard.canActivate(ec)).resolves.toBe(true);
    expect((req.auth as unknown as MaybeUnboundAuth).tenantId).toBeNull();
  });

  it('skips non-HTTP (WebSocket) contexts — the gateway authenticates those itself', async () => {
    const verify = vi.fn();
    const guard = makeGuard(false, false, verify);
    const { ec } = ctx({}, 'ws'); // no token, ws context
    await expect(guard.canActivate(ec)).resolves.toBe(true); // not rejected — HTTP guard doesn't run
    expect(verify).not.toHaveBeenCalled();
  });
});
