import { describe, expect, it, vi } from 'vitest';

import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { WebAuthnController } from './webauthn.controller.js';
import type { WebAuthnService } from './webauthn.service.js';
import { COOKIE_NAME } from './session-token.service.js';

// Contract tier: all five passkey routes are @Public + @AllowUnbound + @PublicRateLimit (the
// pre-account registration/authentication ceremony) — the registration *verify* mints an account so it
// is 201, the rest are 200. Behaviour tier: the two session-minting routes set the secure refresh cookie
// (controller logic); identity resolution + PRF stripping live in the service and are tested there.

function makeController() {
  const session = {
    accessToken: 'wa.access',
    refreshToken: 'wa.refresh',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const webauthn = {
    redeemCode: vi.fn().mockResolvedValue({ ceremonyId: 'cer-1' }),
    getRegistrationOptions: vi.fn().mockResolvedValue({ challenge: 'c' }),
    verifyRegistration: vi.fn().mockResolvedValue(session),
    getAuthenticationOptions: vi.fn().mockResolvedValue({ ceremonyId: 'cer-2', options: {} }),
    verifyAuthentication: vi.fn().mockResolvedValue(session),
  };
  return { controller: new WebAuthnController(webauthn as unknown as WebAuthnService), webauthn };
}
function fakeRes() {
  return { cookie: vi.fn() };
}
function fakeReq() {
  return { headers: { 'user-agent': 'vitest' } } as never;
}

describe('WebAuthnController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['redeemCode', 200],
    ['getRegistrationOptions', 200],
    ['verifyRegistration', 201],
    ['getAuthenticationOptions', 200],
    ['verifyAuthentication', 200],
  ];

  it.each(ROUTES)(
    '%s is public, unbound, rate-limited, with the expected status',
    (method, httpCode) => {
      expect(reflectRouteMeta(WebAuthnController, method)).toEqual({
        isPublic: true,
        isAllowUnbound: true,
        hasPublicRateLimit: true,
        httpCode,
        guards: [],
      });
    },
  );
});

describe('WebAuthnController delegation + cookie', () => {
  it('redeemCode forwards the invite code', async () => {
    const { controller, webauthn } = makeController();
    await expect(controller.redeemCode({ code: 'inv' })).resolves.toEqual({ ceremonyId: 'cer-1' });
    expect(webauthn.redeemCode).toHaveBeenCalledWith('inv');
  });

  it('verifyRegistration mints a session and sets a HttpOnly/Secure/Strict cookie', async () => {
    const { controller } = makeController();
    const res = fakeRes();
    await expect(
      controller.verifyRegistration(
        { ceremonyId: 'cer-1', registrationResponse: {} as never },
        res as never,
      ),
    ).resolves.toEqual({ accessToken: 'wa.access' });
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'wa.refresh',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
  });

  it('verifyAuthentication mints a session and sets a HttpOnly/Secure/Strict cookie', async () => {
    const { controller } = makeController();
    const res = fakeRes();
    await expect(
      controller.verifyAuthentication(
        { ceremonyId: 'cer-2', authenticationResponse: {} as never },
        res as never,
        fakeReq(),
        '203.0.113.1',
      ),
    ).resolves.toEqual({ accessToken: 'wa.access' });
    expect(res.cookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      'wa.refresh',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict' }),
    );
  });
});
