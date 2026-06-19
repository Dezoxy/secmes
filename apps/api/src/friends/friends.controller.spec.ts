import { describe, expect, it, vi } from 'vitest';

import { SendFriendRequestSchema } from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { FriendsController } from './friends.controller.js';
import type { FriendsService } from './friends.service.js';

// Controller spec — two tiers:
//  - contract tier: the decorator posture of each route (none public; the uniform-202 status; 204s)
//  - behaviour tier: what the handler body itself does — the uniform-202 constant, audit-id sanitisation,
//    and list-shape mapping. Services are faked (vi.fn), so no DB is needed.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const VALID_ARGUS_ID = 'argus-abcdefghjkmnpqrs-test'; // matches the controller's ARGUS_ID_RE

function makeController() {
  const friends = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    listFriends: vi.fn().mockResolvedValue([]),
    listRequests: vi.fn().mockResolvedValue([]),
    accept: vi.fn().mockResolvedValue(undefined),
    decline: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    unfriend: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const controller = new FriendsController(
    friends as unknown as FriendsService,
    audit as unknown as AuditService,
  );
  return { controller, friends, audit };
}

describe('FriendsController route contract', () => {
  // Every friends route is authenticated (none @Public) and rate-limited. The action verbs return 204,
  // the lists 200, and sendRequest pins the uniform 202 that hides the request outcome.
  const ROUTES: ReadonlyArray<[string, ReturnType<typeof reflectRouteMeta>]> = [
    [
      'sendRequest',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: 202,
        guards: [],
      },
    ],
    [
      'listFriends',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: undefined,
        guards: [],
      },
    ],
    [
      'listRequests',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: undefined,
        guards: [],
      },
    ],
    [
      'accept',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: 204,
        guards: [],
      },
    ],
    [
      'decline',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: 204,
        guards: [],
      },
    ],
    [
      'cancel',
      {
        isPublic: false,
        isAllowUnbound: false,
        hasPublicRateLimit: false,
        httpCode: 204,
        guards: [],
      },
    ],
    [
      'unfriend',
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
    expect(reflectRouteMeta(FriendsController, method)).toEqual(expected);
  });
});

describe('FriendsController.sendRequest — uniform 202 + audit sanitisation', () => {
  it('returns the constant {status:"accepted"} regardless of the service outcome (no enumeration oracle)', async () => {
    const { controller } = makeController();
    await expect(controller.sendRequest(auth, { argusId: VALID_ARGUS_ID })).resolves.toEqual({
      status: 'accepted',
    });
  });

  it('records a well-formed argus-id verbatim in the audit metadata', async () => {
    const { controller, audit } = makeController();
    await controller.sendRequest(auth, { argusId: VALID_ARGUS_ID });
    expect(audit.record).toHaveBeenCalledWith(
      auth.tenantId,
      expect.objectContaining({
        eventType: 'friends.request_created',
        actorSub: auth.sub,
        metadata: { targetArgusId: VALID_ARGUS_ID },
      }),
    );
  });

  it('replaces a malformed argus-id with <invalid-format> so a probe cannot smuggle data into the audit log', async () => {
    const { controller, audit } = makeController();
    await controller.sendRequest(auth, { argusId: 'not a real id; https://evil/leak' });
    expect(audit.record).toHaveBeenCalledWith(
      auth.tenantId,
      expect.objectContaining({ metadata: { targetArgusId: '<invalid-format>' } }),
    );
  });

  it('still delegates the raw probed id to the service (the service decides the real outcome)', async () => {
    const { controller, friends } = makeController();
    await controller.sendRequest(auth, { argusId: VALID_ARGUS_ID });
    expect(friends.sendRequest).toHaveBeenCalledWith(auth, VALID_ARGUS_ID);
  });
});

describe('FriendsController list mapping', () => {
  it('wraps the service result in {friends}', async () => {
    const { controller, friends } = makeController();
    const list = [{ userId: 'u1' }];
    friends.listFriends.mockResolvedValue(list);
    await expect(controller.listFriends(auth)).resolves.toEqual({ friends: list });
  });

  it('wraps the service result in {requests} and forwards the box', async () => {
    const { controller, friends } = makeController();
    const reqs = [{ requestId: 'r1' }];
    friends.listRequests.mockResolvedValue(reqs);
    await expect(controller.listRequests(auth, 'incoming')).resolves.toEqual({ requests: reqs });
    expect(friends.listRequests).toHaveBeenCalledWith(auth, 'incoming');
  });
});

describe('FriendsController validation seam (representative)', () => {
  // Param pipes do not run on a direct method call, so the validation contract is exercised here against
  // the same Zod schema the route wires. Full per-route validation lives in the @argus/contracts tests.
  it('the send-request body schema rejects a non-string argusId and accepts a valid one', () => {
    const pipe = new ZodValidationPipe(SendFriendRequestSchema);
    expect(() => pipe.transform({ argusId: 123 })).toThrow();
    expect(() => pipe.transform({})).toThrow();
    expect(pipe.transform({ argusId: VALID_ARGUS_ID })).toEqual({ argusId: VALID_ARGUS_ID });
  });
});
