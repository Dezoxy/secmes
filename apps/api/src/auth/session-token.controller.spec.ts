import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import type { VerifiedAuth } from './auth.service.js';
import { SessionTokenController } from './session-token.controller.js';
import { COOKIE_NAME, type SessionTokenService } from './session-token.service.js';

// Contract tier: refresh is @Public + @AllowUnbound + @PublicRateLimit (pre-auth cookie exchange) = 200;
// logout is authenticated = 204. Behaviour tier: the CSRF-header + cookie-presence gates on refresh, and
// the secure cookie flags it sets — that is the controller's own logic, not the service's.

const auth: VerifiedAuth = {
  sub: 'argusid:me',
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  sid: 'sess-1',
};

function makeController() {
  const sessions = {
    rotateRefresh: vi.fn().mockResolvedValue({
      accessToken: 'new.access',
      refreshToken: 'new.refresh',
      expiresAt: new Date(Date.now() + 60_000),
    }),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new SessionTokenController(
    sessions as unknown as SessionTokenService,
    audit as unknown as AuditService,
  );
  return { controller, sessions, audit };
}

function fakeReq(headers: Record<string, string>, cookies: Record<string, string>) {
  return { headers, cookies, ip: '203.0.113.1' } as never;
}
function fakeRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn() };
}

describe('SessionTokenController route contract', () => {
  it('refresh is public, unbound, rate-limited, and returns 200', () => {
    expect(reflectRouteMeta(SessionTokenController, 'refresh')).toEqual({
      isPublic: true,
      isAllowUnbound: true,
      hasPublicRateLimit: true,
      httpCode: 200,
      guards: [],
    });
  });

  it('logout is authenticated (not public) and returns 204', () => {
    expect(reflectRouteMeta(SessionTokenController, 'logout')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 204,
      guards: [],
    });
  });
});

describe('SessionTokenController.refresh — CSRF + cookie gates', () => {
  it('rejects a request missing the X-Argus-Refresh header', async () => {
    const { controller, sessions } = makeController();
    const req = fakeReq({}, { [COOKIE_NAME]: 'old.refresh' });
    await expect(controller.refresh(req, fakeRes() as never, '203.0.113.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sessions.rotateRefresh).not.toHaveBeenCalled();
  });

  it('rejects a request missing the refresh cookie', async () => {
    const { controller, sessions } = makeController();
    const req = fakeReq({ 'x-argus-refresh': '1' }, {});
    await expect(controller.refresh(req, fakeRes() as never, '203.0.113.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sessions.rotateRefresh).not.toHaveBeenCalled();
  });

  it('rotates and sets a HttpOnly/Secure/SameSite=Strict cookie on success', async () => {
    const { controller, sessions } = makeController();
    const req = fakeReq({ 'x-argus-refresh': '1' }, { [COOKIE_NAME]: 'old.refresh' });
    const res = fakeRes();
    await expect(controller.refresh(req, res as never, '203.0.113.1')).resolves.toEqual({
      accessToken: 'new.access',
    });
    expect(sessions.rotateRefresh).toHaveBeenCalledWith('old.refresh');
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'new.refresh',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
  });
});

describe('SessionTokenController.logout', () => {
  it('revokes the session, records the event, and clears the cookie', async () => {
    const { controller, sessions, audit } = makeController();
    const req = fakeReq({ 'user-agent': 'vitest' }, {});
    const res = fakeRes();
    await controller.logout(auth, req, res as never);
    expect(sessions.revokeSession).toHaveBeenCalledWith(auth.tenantId, {
      userId: auth.userId,
      sessionId: auth.sid,
    });
    expect(audit.record).toHaveBeenCalledWith(
      auth.tenantId,
      expect.objectContaining({ eventType: 'session.logout', actorSub: auth.sub }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(Object));
  });

  it('still clears the cookie for a token with no userId/sid (Zitadel) without revoking', async () => {
    const { controller, sessions } = makeController();
    const oidcAuth: VerifiedAuth = { sub: 'oidc:x', tenantId: auth.tenantId };
    const res = fakeRes();
    await controller.logout(oidcAuth, fakeReq({}, {}), res as never);
    expect(sessions.revokeSession).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(Object));
  });
});
