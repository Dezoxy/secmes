import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { WelcomesController } from './welcomes.controller.js';
import type { MessagingService } from './messaging.service.js';

// Contract tier: all four welcome routes are authenticated (none @Public, no extra guards); deliver keeps
// the @Post default 201, consume is 204, the GETs are 200. Behaviour tier: the controller relays the
// caller's device id + proof-of-possession token to the service — the proof is *verified* in the service
// (tested there), so here we assert the controller forwards it rather than dropping or substituting it.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const CONV = '33333333-3333-3333-3333-333333333333';
const WELCOME = '44444444-4444-4444-4444-444444444444';
const DEVICE = '55555555-5555-5555-5555-555555555555';

function makeController() {
  const messaging = {
    deliverWelcome: vi.fn().mockResolvedValue({ welcomeId: WELCOME }),
    listMyWelcomes: vi.fn().mockResolvedValue([]),
    getWelcomeMaterial: vi.fn().mockResolvedValue({ welcome: 'b64', ratchetTree: 'b64' }),
    consumeWelcome: vi.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new WelcomesController(messaging as unknown as MessagingService),
    messaging,
  };
}

describe('WelcomesController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['deliver', 201], // @Post verb default
    ['list', 200], // @Get verb default
    ['material', 200],
    ['consume', 204], // @HttpCode(204)
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(WelcomesController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('WelcomesController delegation', () => {
  it('deliver forwards the conversation id + opaque welcome body', async () => {
    const { controller, messaging } = makeController();
    const body = {
      recipientUserId: 'u2',
      recipientDeviceId: DEVICE,
      welcome: 'b64',
      ratchetTree: 'b64',
    };
    await controller.deliver(auth, CONV, body);
    expect(messaging.deliverWelcome).toHaveBeenCalledWith(auth, CONV, body);
  });

  it('list forwards the calling device id + limit', async () => {
    const { controller, messaging } = makeController();
    await controller.list(auth, { deviceId: DEVICE, limit: 25 });
    expect(messaging.listMyWelcomes).toHaveBeenCalledWith(auth, DEVICE, 25);
  });

  it('material forwards the device id + proof-of-possession token', async () => {
    const { controller, messaging } = makeController();
    await controller.material(auth, WELCOME, { deviceId: DEVICE, proof: 'pop-proof' });
    expect(messaging.getWelcomeMaterial).toHaveBeenCalledWith(auth, WELCOME, DEVICE, 'pop-proof');
  });

  it('consume forwards the device id + proof-of-possession token', async () => {
    const { controller, messaging } = makeController();
    await controller.consume(auth, WELCOME, { deviceId: DEVICE, proof: 'pop-proof' });
    expect(messaging.consumeWelcome).toHaveBeenCalledWith(auth, WELCOME, DEVICE, 'pop-proof');
  });
});
