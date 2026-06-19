import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { MessagingController } from './messaging.controller.js';
import type { MessagingService } from './messaging.service.js';

// Contract tier: every conversation route is authenticated (none @Public, no extra guards). createConversation
// keeps the @Post default 201; the idempotent send + commit deliberately return 200. Behaviour tier: the
// controller is a thin relay — the security-relevant property is that it forwards the opaque ciphertext body
// to the service untouched (crypto-blind: it never inspects or reshapes message content).

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const CONV = '33333333-3333-3333-3333-333333333333';

function makeController() {
  const messaging = {
    createConversation: vi.fn().mockResolvedValue({ conversationId: CONV }),
    sendMessage: vi
      .fn()
      .mockResolvedValue({ messageId: 'm1', createdAt: 'now', deduplicated: false }),
    postCommit: vi.fn().mockResolvedValue({ id: 'c1', epoch: 1, deduplicated: false }),
    listCommits: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
    getConversationMembers: vi.fn().mockResolvedValue([]),
  };
  return {
    controller: new MessagingController(messaging as unknown as MessagingService),
    messaging,
  };
}

describe('MessagingController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number | undefined]> = [
    ['createConversation', undefined], // @Post default 201
    ['sendMessage', 200],
    ['postCommit', 200],
    ['listCommits', undefined],
    ['listMessages', undefined],
    ['listConversationMembers', undefined],
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(MessagingController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('MessagingController delegation', () => {
  it('createConversation forwards members + the explicit isDirect flag', async () => {
    const { controller, messaging } = makeController();
    await controller.createConversation(auth, { memberUserIds: ['u2'], isDirect: true });
    expect(messaging.createConversation).toHaveBeenCalledWith(auth, ['u2'], true);
  });

  it('sendMessage relays the opaque ciphertext body to the service untouched (crypto-blind)', async () => {
    const { controller, messaging } = makeController();
    const body = { clientMessageId: 'cm1', ciphertext: 'b64==', alg: 'MLS_1.0', epoch: 2 };
    await controller.sendMessage(auth, CONV, body);
    expect(messaging.sendMessage).toHaveBeenCalledWith(auth, CONV, body);
  });

  it('postCommit relays the opaque commit body to the service untouched', async () => {
    const { controller, messaging } = makeController();
    const body = {
      clientCommitId: 'cc1',
      epoch: 1,
      commit: 'b64==',
      welcomes: [],
      addedUserIds: [],
      removedUserIds: [],
    };
    await controller.postCommit(auth, CONV, body);
    expect(messaging.postCommit).toHaveBeenCalledWith(auth, CONV, body);
  });
});
