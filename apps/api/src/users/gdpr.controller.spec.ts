import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { CONFIRM_DELETE_VALUE, GdprController } from './gdpr.controller.js';
import type { GdprService } from './gdpr.service.js';

// Contract tier: export=200 (verb default), delete=204, both authenticated (not @Public).
// Behaviour tier: the X-Confirm-Delete re-auth gate and the Content-Disposition attachment header —
// the only logic the controller itself owns (the export shape is built by the service).

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };

function makeController() {
  const gdpr = {
    exportAccount: vi.fn().mockResolvedValue({ schemaVersion: '1', profile: null }),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new GdprController(gdpr as unknown as GdprService);
  return { controller, gdpr };
}

function fakeRes() {
  return { setHeader: vi.fn() };
}

describe('GdprController route contract', () => {
  const ROUTES: ReadonlyArray<[string, ReturnType<typeof reflectRouteMeta>]> = [
    [
      'export',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: undefined,
        guards: [],
      },
    ],
    [
      'delete',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: 204,
        guards: [],
      },
    ],
  ];
  it.each(ROUTES)('%s has the expected route contract', (method, expected) => {
    expect(reflectRouteMeta(GdprController, method)).toEqual(expected);
  });
});

describe('GdprController.export', () => {
  it('sets a Content-Disposition attachment header and returns the service payload', async () => {
    const { controller, gdpr } = makeController();
    const res = fakeRes();
    const out = await controller.export(auth, res as never);
    expect(gdpr.exportAccount).toHaveBeenCalledWith(auth);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/^attachment; filename="argus-export-\d{4}-\d{2}-\d{2}\.json"$/),
    );
    expect(out).toEqual({ schemaVersion: '1', profile: null });
  });
});

describe('GdprController.delete — X-Confirm-Delete gate', () => {
  it(`deletes only when the header equals "${CONFIRM_DELETE_VALUE}"`, async () => {
    const { controller, gdpr } = makeController();
    await expect(controller.delete(auth, CONFIRM_DELETE_VALUE)).resolves.toBeUndefined();
    expect(gdpr.deleteAccount).toHaveBeenCalledWith(auth);
  });

  it('rejects a missing header without calling the service', async () => {
    const { controller, gdpr } = makeController();
    await expect(controller.delete(auth, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(gdpr.deleteAccount).not.toHaveBeenCalled();
  });

  it('rejects a wrong header value without calling the service', async () => {
    const { controller, gdpr } = makeController();
    await expect(controller.delete(auth, 'yes-please')).rejects.toBeInstanceOf(BadRequestException);
    expect(gdpr.deleteAccount).not.toHaveBeenCalled();
  });
});
