import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { UserThrottlerGuard } from './user-throttler.guard.js';

const AUTH: VerifiedAuth = { sub: 'u1', tenantId: '11111111-1111-1111-1111-111111111111' };

// Subclass to reach the two protected overrides under test; the base ctor just needs stub deps since we
// never exercise the storage path here (only the tracking key + skip predicate, which are pure).
class TestGuard extends UserThrottlerGuard {
  track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
  skip(context: ExecutionContext): Promise<boolean> {
    return this.shouldSkip(context);
  }
}

function makeGuard(isPublic: boolean): TestGuard {
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  const storage = {} as unknown as ThrottlerStorage;
  return new TestGuard({ throttlers: [] }, storage, reflector);
}

function httpCtx(): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('UserThrottlerGuard — tracking key', () => {
  it('keys on the VERIFIED tenant+subject when req.auth is present', async () => {
    const key = await makeGuard(false).track({ auth: AUTH, ip: '203.0.113.7' });
    // Per-user, tenant-scoped — never the IP when a verified identity exists (NAT-safe, cross-tenant-safe).
    expect(key).toBe(`u:${AUTH.tenantId}:${AUTH.sub}`);
  });

  it('falls back to the IP before auth runs (pre-auth brute-force protection)', async () => {
    const key = await makeGuard(false).track({ ip: '203.0.113.7' });
    expect(key).toBe('ip:203.0.113.7');
  });

  it('falls back to ip:unknown when neither auth nor ip is present', async () => {
    const key = await makeGuard(false).track({});
    expect(key).toBe('ip:unknown');
  });
});

describe('UserThrottlerGuard — skip predicate', () => {
  it('skips non-HTTP (WebSocket) contexts — the gateway throttles its own frames', async () => {
    const wsCtx = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(makeGuard(false).skip(wsCtx)).resolves.toBe(true);
  });

  it('skips @Public routes (health/version) — same exemption as the auth guard', async () => {
    await expect(makeGuard(true).skip(httpCtx())).resolves.toBe(true);
  });

  it('does NOT skip a normal authenticated HTTP route', async () => {
    await expect(makeGuard(false).skip(httpCtx())).resolves.toBe(false);
  });
});
