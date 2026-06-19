import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { SyncController } from './sync.controller.js';
import type { MessagingService } from './messaging.service.js';

// Contract tier: the single sync route is an authenticated 200 GET (not @Public, no extra guards). Behaviour
// tier: thin relay — the controller forwards auth + the validated query (limit/after cursor) to the service.
// The page it returns carries opaque MLS ciphertext the server never decrypts (crypto-blind catch-up).

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };

function makeController() {
  const messaging = {
    syncMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
  };
  return { controller: new SyncController(messaging as unknown as MessagingService), messaging };
}

describe('SyncController route contract', () => {
  it('sync is an authenticated 200 GET', () => {
    expect(reflectRouteMeta(SyncController, 'sync')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [],
    });
  });
});

describe('SyncController behaviour', () => {
  it('forwards the validated query (limit + after cursor) to the service', async () => {
    const { controller, messaging } = makeController();
    const query = { limit: 50, after: 'cursor' };
    await controller.sync(auth, query);
    expect(messaging.syncMessages).toHaveBeenCalledWith(auth, query);
  });
});
