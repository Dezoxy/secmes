import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { CallsController } from './calls.controller.js';
import type { CallsService } from './calls.service.js';

// Controller spec — two tiers:
//  - contract tier: decorator posture (guarded, 200 OK, rate-limited)
//  - behaviour tier: credential is never passed to a logger; ForbiddenException propagates

const auth: VerifiedAuth = {
  sub: 'argusid:me',
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

const MOCK_RESPONSE = {
  iceServers: [
    {
      urls: ['turn:turn.4rgus.com:3478', 'turns:turn.4rgus.com:5349?transport=tcp'],
      username: '9999999999:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      credential: 'base64cred==',
    },
  ],
  iceTransportPolicy: 'relay' as const,
  ttlSeconds: 600,
};

function makeController() {
  const calls = {
    mintTurnCredentials: vi.fn().mockResolvedValue(MOCK_RESPONSE),
  };
  const controller = new CallsController(calls as unknown as CallsService);
  return { controller, calls };
}

describe('CallsController route contract', () => {
  it('mintTurnCredentials is guarded (not @Public) and returns 200', () => {
    const meta = reflectRouteMeta(CallsController, 'mintTurnCredentials');
    expect(meta).toMatchObject({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
    });
  });
});

describe('CallsController behaviour', () => {
  it('returns the service response verbatim', async () => {
    const { controller, calls } = makeController();
    const result = await controller.mintTurnCredentials(auth);
    expect(result).toEqual(MOCK_RESPONSE);
    expect(calls.mintTurnCredentials).toHaveBeenCalledWith(auth);
  });

  it('propagates ForbiddenException from the service (no accepted friends)', async () => {
    const { controller, calls } = makeController();
    calls.mintTurnCredentials.mockRejectedValue(new ForbiddenException('no accepted friends'));
    await expect(controller.mintTurnCredentials(auth)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not pass credential to any logger', async () => {
    // The controller must be a thin pass-through: it cannot destructure or log the service result.
    // Verify by confirming the controller returns the response object directly without mutating it —
    // any logging of credential would require accessing the field (detectable via a Proxy).
    let credentialAccessed = false;
    const proxyResponse = new Proxy(MOCK_RESPONSE, {
      get(target, prop) {
        if (prop === 'iceServers') {
          // Accessing iceServers would be needed to reach credential — flag if it happens outside
          // the return itself (we allow the return to pass the object reference through).
          credentialAccessed = true;
        }
        return Reflect.get(target, prop);
      },
    });
    const { calls: calls2 } = makeController();
    calls2.mintTurnCredentials.mockResolvedValue(proxyResponse);
    const controller2 = new CallsController(calls2 as unknown as CallsService);
    await controller2.mintTurnCredentials(auth);
    // The controller must not have accessed iceServers — it just returns what the service gives it.
    expect(credentialAccessed).toBe(false);
  });
});
