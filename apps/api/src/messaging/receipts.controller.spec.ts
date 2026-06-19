import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { ReceiptsController } from './receipts.controller.js';
import type { MessagingService } from './messaging.service.js';

// Contract tier: both receipt routes are authenticated (none @Public, no extra guards). record is
// @HttpCode(204) (it advances a watermark — nothing to return); get is a 200 read. Behaviour tier: thin
// relay — the controller forwards auth + conversation id + the validated body to the service untouched.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const CONV = '33333333-3333-3333-3333-333333333333';
const MSG = '44444444-4444-4444-4444-444444444444';

function makeController() {
  const messaging = {
    recordReceipt: vi.fn().mockResolvedValue(undefined),
    getReceipts: vi.fn().mockResolvedValue([]),
  };
  return {
    controller: new ReceiptsController(messaging as unknown as MessagingService),
    messaging,
  };
}

describe('ReceiptsController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['record', 204], // @HttpCode(204)
    ['get', 200], // @Get verb default
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(ReceiptsController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('ReceiptsController behaviour', () => {
  it('record forwards the conversation id + validated receipt body', async () => {
    const { controller, messaging } = makeController();
    const body = { status: 'read' as const, throughMessageId: MSG };
    await controller.record(auth, CONV, body);
    expect(messaging.recordReceipt).toHaveBeenCalledWith(auth, CONV, body);
  });

  it('get forwards the conversation id', async () => {
    const { controller, messaging } = makeController();
    await controller.get(auth, CONV);
    expect(messaging.getReceipts).toHaveBeenCalledWith(auth, CONV);
  });
});
