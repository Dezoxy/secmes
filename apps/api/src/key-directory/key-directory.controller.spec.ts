import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { KeyDirectoryController } from './key-directory.controller.js';
import type { KeyDirectoryService } from './key-directory.service.js';

// Contract tier: all four key-directory routes are authenticated (none @Public, no extra guards) and all
// return 200 — every one is a @Post @HttpCode(200) because each is a mutation that returns data, not a
// resource creation. Behaviour tier: `claim` must collapse "no package available" into an opaque 404 (no
// oracle that distinguishes a missing user from an exhausted one), and `claimAll` must forward its optional
// device filters faithfully (they drive the group-add Welcome fan-out).

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const USER = '22222222-2222-2222-2222-222222222222';
const DEVICE = '33333333-3333-3333-3333-333333333333';
const EXCLUDE = '44444444-4444-4444-4444-444444444444';

function makeController() {
  const dir = {
    publish: vi.fn().mockResolvedValue({ deviceId: DEVICE, published: 2, available: 5 }),
    claim: vi
      .fn()
      .mockResolvedValue({ deviceId: DEVICE, signaturePublicKey: 'spk', keyPackage: 'kp' }),
    claimAll: vi.fn().mockResolvedValue([]),
    revokeUnclaimed: vi.fn().mockResolvedValue({ revoked: 3 }),
  };
  return { controller: new KeyDirectoryController(dir as unknown as KeyDirectoryService), dir };
}

describe('KeyDirectoryController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['publish', 200],
    ['claim', 200],
    ['claimAll', 200],
    ['revoke', 200],
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(KeyDirectoryController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('KeyDirectoryController behaviour', () => {
  it('publish forwards the signature key + key packages', async () => {
    const { controller, dir } = makeController();
    await controller.publish(auth, { signaturePublicKey: 'spk', keyPackages: ['a', 'b'] });
    expect(dir.publish).toHaveBeenCalledWith(auth, 'spk', ['a', 'b']);
  });

  it('claim returns the claimed package when one is available', async () => {
    const { controller, dir } = makeController();
    const result = await controller.claim(auth, USER);
    expect(result).toEqual({ deviceId: DEVICE, signaturePublicKey: 'spk', keyPackage: 'kp' });
    expect(dir.claim).toHaveBeenCalledWith(auth, USER);
  });

  it('claim throws an opaque 404 when no package is available (no enumeration oracle)', async () => {
    const { controller, dir } = makeController();
    dir.claim.mockResolvedValue(null);
    await expect(controller.claim(auth, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('claimAll forwards the optional deviceId + excludeDeviceId filters', async () => {
    const { controller, dir } = makeController();
    await controller.claimAll(auth, USER, DEVICE, EXCLUDE);
    expect(dir.claimAll).toHaveBeenCalledWith(auth, USER, DEVICE, EXCLUDE);
  });

  it('claimAll forwards undefined filters when omitted (group-add fan-out)', async () => {
    const { controller, dir } = makeController();
    await controller.claimAll(auth, USER);
    expect(dir.claimAll).toHaveBeenCalledWith(auth, USER, undefined, undefined);
  });

  it('revoke forwards the caller device signature key', async () => {
    const { controller, dir } = makeController();
    await controller.revoke(auth, { signaturePublicKey: 'spk' });
    expect(dir.revokeUnclaimed).toHaveBeenCalledWith(auth, 'spk');
  });
});
