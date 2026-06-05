import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import type { AuditService } from './audit.service.js';
import { AuthSessionController } from './auth-session.controller.js';

const AUTH: VerifiedAuth = { sub: 'sub-1', tenantId: '11111111-1111-1111-1111-111111111111' };

describe('AuthSessionController', () => {
  it('login records auth.login from the verified token + request metadata (not the body)', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const ctrl = new AuthSessionController({ record } as unknown as AuditService);
    await ctrl.login(AUTH, '203.0.113.5', 'Mozilla/5.0');
    expect(record).toHaveBeenCalledWith(AUTH.tenantId, {
      eventType: 'auth.login',
      actorSub: AUTH.sub,
      ip: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('logout records auth.logout', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const ctrl = new AuthSessionController({ record } as unknown as AuditService);
    await ctrl.logout(AUTH, '203.0.113.5', undefined);
    expect(record).toHaveBeenCalledWith(AUTH.tenantId, {
      eventType: 'auth.logout',
      actorSub: AUTH.sub,
      ip: '203.0.113.5',
      userAgent: undefined,
    });
  });
});
