import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { DevicesController } from './devices.controller.js';
import type { DevicesService } from './devices.service.js';

// Contract tier: every device route is authenticated (none @Public, no extra guards). register/approve are
// @HttpCode(200); reject/withdraw/migrate are 204; the two GETs are 200. Behaviour tier: the controller does
// real shaping — `toDto` is null-safe on resolvedAt/approverSignaturePublicKey, `list` rejects an invalid
// status query before hitting the service, and `listConversations` emits BOTH the new `conversations` array
// and the deprecated `conversationIds` back-compat shim from the same rows.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const ENROLL = '22222222-2222-2222-2222-222222222222';
const DEVICE = '33333333-3333-3333-3333-333333333333';

const enrollmentRow = {
  id: ENROLL,
  requestingDeviceId: DEVICE,
  approvedByDeviceId: null,
  fingerprint: 'fp',
  status: 'pending',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-01T00:15:00.000Z'),
  resolvedAt: null,
  approverSignaturePublicKey: null,
};

function makeController() {
  const devices = {
    registerEnrollment: vi.fn().mockResolvedValue(enrollmentRow),
    listEnrollments: vi.fn().mockResolvedValue([enrollmentRow]),
    approveEnrollment: vi.fn().mockResolvedValue(enrollmentRow),
    rejectEnrollment: vi.fn().mockResolvedValue(undefined),
    withdrawDevice: vi.fn().mockResolvedValue(undefined),
    migrateDevice: vi.fn().mockResolvedValue(undefined),
    listMyConversations: vi.fn().mockResolvedValue([]),
  };
  return { controller: new DevicesController(devices as unknown as DevicesService), devices };
}

describe('DevicesController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['register', 200],
    ['list', 200],
    ['approve', 200],
    ['reject', 204],
    ['withdraw', 204],
    ['migrate', 204],
    ['listConversations', 200],
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(DevicesController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('DevicesController behaviour', () => {
  it('register maps the enrollment row to a DTO with ISO timestamps + null-safe fields', async () => {
    const { controller, devices } = makeController();
    const dto = await controller.register(auth, { fingerprint: 'fp', deviceId: DEVICE });
    expect(devices.registerEnrollment).toHaveBeenCalledWith(auth, 'fp', DEVICE);
    expect(dto).toEqual({
      id: ENROLL,
      requestingDeviceId: DEVICE,
      approvedByDeviceId: null,
      fingerprint: 'fp',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:15:00.000Z',
      resolvedAt: null,
      approverSignaturePublicKey: null,
    });
  });

  it('register maps a resolved enrollment with non-null timestamps', async () => {
    const { controller, devices } = makeController();
    devices.registerEnrollment.mockResolvedValue({
      ...enrollmentRow,
      approvedByDeviceId: DEVICE,
      status: 'approved',
      resolvedAt: new Date('2026-01-01T00:05:00.000Z'),
      approverSignaturePublicKey: 'spk',
    });
    const dto = await controller.register(auth, { fingerprint: 'fp', deviceId: DEVICE });
    expect(dto.resolvedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(dto.approverSignaturePublicKey).toBe('spk');
  });

  it('list defaults to no status filter and maps rows to DTOs', async () => {
    const { controller, devices } = makeController();
    const rows = await controller.list(auth);
    expect(devices.listEnrollments).toHaveBeenCalledWith(auth, undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ENROLL);
  });

  it('list passes through a valid status filter', async () => {
    const { controller, devices } = makeController();
    await controller.list(auth, 'approved');
    expect(devices.listEnrollments).toHaveBeenCalledWith(auth, 'approved');
  });

  it('list rejects an unknown status before touching the service', async () => {
    const { controller, devices } = makeController();
    await expect(controller.list(auth, 'bogus')).rejects.toBeInstanceOf(BadRequestException);
    expect(devices.listEnrollments).not.toHaveBeenCalled();
  });

  it('approve forwards the approving device id + proof', async () => {
    const { controller, devices } = makeController();
    await controller.approve(auth, ENROLL, { approvingDeviceId: DEVICE, proof: 'pf' });
    expect(devices.approveEnrollment).toHaveBeenCalledWith(auth, ENROLL, DEVICE, 'pf');
  });

  it('reject forwards the enrollment id', async () => {
    const { controller, devices } = makeController();
    await controller.reject(auth, ENROLL);
    expect(devices.rejectEnrollment).toHaveBeenCalledWith(auth, ENROLL);
  });

  it('withdraw forwards the signature key + proof', async () => {
    const { controller, devices } = makeController();
    await controller.withdraw(auth, { signaturePublicKey: 'spk', proof: 'pf' });
    expect(devices.withdrawDevice).toHaveBeenCalledWith(auth, 'spk', 'pf');
  });

  it('migrate forwards the signature key + proof', async () => {
    const { controller, devices } = makeController();
    await controller.migrate(auth, { signaturePublicKey: 'spk', proof: 'pf' });
    expect(devices.migrateDevice).toHaveBeenCalledWith(auth, 'spk', 'pf');
  });

  it('listConversations emits both the conversations array and the deprecated conversationIds shim', async () => {
    const { controller, devices } = makeController();
    devices.listMyConversations.mockResolvedValue([
      {
        conversationId: 'c1',
        isDirect: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        peerUserId: 'peer-uuid',
      },
      {
        conversationId: 'c2',
        isDirect: null,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        peerUserId: null,
      },
    ]);
    const result = await controller.listConversations(auth);
    expect(result.conversations).toEqual([
      { id: 'c1', isDirect: true, createdAt: '2026-01-01T00:00:00.000Z', peerUserId: 'peer-uuid' },
      { id: 'c2', isDirect: null, createdAt: '2026-01-02T00:00:00.000Z', peerUserId: null },
    ]);
    expect(result.conversationIds).toEqual(['c1', 'c2']);
  });
});
