import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import type { UserService } from '../users/user.service.js';
import type { AuditService } from './audit.service.js';
import { AuthSessionController } from './auth-session.controller.js';

const AUTH: VerifiedAuth = {
  sub: 'sub-1',
  tenantId: '11111111-1111-1111-1111-111111111111',
  email: 'u@u.test',
};

function make(): {
  ctrl: AuthSessionController;
  record: ReturnType<typeof vi.fn>;
  provision: ReturnType<typeof vi.fn>;
} {
  const record = vi.fn().mockResolvedValue(undefined);
  const provision = vi.fn().mockResolvedValue({ id: 'u', email: 'u@u.test', displayName: null });
  const ctrl = new AuthSessionController(
    { record } as unknown as AuditService,
    { provisionFromToken: provision } as unknown as UserService,
  );
  return { ctrl, record, provision };
}

describe('AuthSessionController', () => {
  it('login provisions the user then records auth.login (token + request metadata, not body)', async () => {
    const { ctrl, record, provision } = make();
    await ctrl.login(AUTH, '203.0.113.5', { 'user-agent': 'Mozilla/5.0' });
    expect(provision).toHaveBeenCalledWith(AUTH);
    expect(record).toHaveBeenCalledWith(AUTH.tenantId, {
      eventType: 'auth.login',
      actorSub: AUTH.sub,
      ip: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('does not audit a login if provisioning fails', async () => {
    const { ctrl, record, provision } = make();
    provision.mockRejectedValueOnce(new Error('no email'));
    await expect(
      ctrl.login(AUTH, '203.0.113.5', { 'user-agent': 'Mozilla/5.0' }),
    ).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });

  it('logout records auth.logout (user-agent absent → undefined)', async () => {
    const { ctrl, record } = make();
    await ctrl.logout(AUTH, '203.0.113.5', {});
    expect(record).toHaveBeenCalledWith(AUTH.tenantId, {
      eventType: 'auth.logout',
      actorSub: AUTH.sub,
      ip: '203.0.113.5',
      userAgent: undefined,
    });
  });
});
