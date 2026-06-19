import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { PushController } from './push.controller.js';
import type { PushService } from './push.service.js';

// Contract tier: both push routes are authenticated (none @Public, no extra guards) and @HttpCode(204)
// — they mutate the caller's own subscription and return nothing. Behaviour tier: subscribe forwards the
// validated body and translates a service TypeError (unsafe endpoint / foreign device) into a 400 rather
// than a 500, while re-throwing anything else; unsubscribe forwards the device id. Subscriptions are
// per-device routing metadata only — no message content rides this path.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const DEVICE = '22222222-2222-2222-2222-222222222222';
const body = {
  deviceId: DEVICE,
  subscription: { p256dh: 'p', auth: 'a', endpoint: 'https://push.example/x' },
};

function makeController() {
  const push = {
    upsert: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new PushController(push as unknown as PushService), push };
}

describe('PushController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['subscribe', 204], // @Put + @HttpCode(204)
    ['unsubscribe', 204], // @Delete + @HttpCode(204)
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(PushController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('PushController behaviour', () => {
  it('subscribe forwards the validated body to the service', async () => {
    const { controller, push } = makeController();
    await controller.subscribe(auth, body);
    expect(push.upsert).toHaveBeenCalledWith(auth, body);
  });

  it('subscribe translates a service TypeError into a 400 (unsafe endpoint / foreign device)', async () => {
    const { controller, push } = makeController();
    push.upsert.mockRejectedValue(new TypeError('endpoint host is not allowed'));
    await expect(controller.subscribe(auth, body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subscribe re-throws a non-TypeError unchanged (no 400 masking of real failures)', async () => {
    const { controller, push } = makeController();
    const boom = new Error('db down');
    push.upsert.mockRejectedValue(boom);
    await expect(controller.subscribe(auth, body)).rejects.toBe(boom);
  });

  it('unsubscribe forwards the device id', async () => {
    const { controller, push } = makeController();
    await controller.unsubscribe(auth, DEVICE);
    expect(push.remove).toHaveBeenCalledWith(auth, DEVICE);
  });
});
