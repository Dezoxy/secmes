import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthService, VerifiedAuth } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const AUTH: VerifiedAuth = { sub: 'u1', tenantId: '11111111-1111-1111-1111-111111111111' };

function ctx(headers: Record<string, string | undefined>): {
  req: { headers: Record<string, string | undefined>; auth?: VerifiedAuth };
  ec: ExecutionContext;
} {
  const req = { headers };
  const ec = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, ec };
}

function makeGuard(isPublic: boolean, verify = vi.fn().mockResolvedValue(AUTH)): JwtAuthGuard {
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
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
    const verify = vi.fn().mockResolvedValue(AUTH);
    const guard = makeGuard(false, verify);
    const { ec, req } = ctx({ authorization: 'Bearer good.token' });
    await expect(guard.canActivate(ec)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good.token');
    expect(req.auth).toEqual(AUTH);
  });

  it('ignores a client-supplied X-Tenant-Id header (tenant comes from the token only)', async () => {
    const guard = makeGuard(false, vi.fn().mockResolvedValue(AUTH));
    const { ec, req } = ctx({
      authorization: 'Bearer good.token',
      'x-tenant-id': '99999999-9999-9999-9999-999999999999', // attacker-supplied; must have no effect
    });
    await expect(guard.canActivate(ec)).resolves.toBe(true);
    expect(req.auth?.tenantId).toBe(AUTH.tenantId); // the token's claim, not the header
  });
});
