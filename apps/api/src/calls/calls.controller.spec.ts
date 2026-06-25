import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { CallsController } from './calls.controller.js';
import type { CallsService } from './calls.service.js';

// Controller spec — two tiers:
//  - contract tier: decorator posture (guarded, httpCode, rate-limited)
//  - behaviour tier: pass-through correctness; no logging of sensitive fields; uniform 202 oracle check

const auth: VerifiedAuth = {
  sub: 'argusid:me',
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};

const FRIEND_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CALL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONV_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const MOCK_TURN = {
  iceServers: [
    {
      urls: ['turn:turn.4rgus.com:3478', 'turns:turn.4rgus.com:5349?transport=tcp'],
      username: '9999999999:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      credential: 'base64cred==',
    },
  ],
  iceTransportPolicy: 'relay' as const,
  ttlSeconds: 600,
};

function makeController() {
  const calls = {
    mintTurnCredentials: vi.fn().mockResolvedValue(MOCK_TURN),
    invite: vi.fn().mockResolvedValue({ callId: CALL_ID }),
    getSettings: vi.fn().mockResolvedValue({ relayOnly: true }),
    updateSettings: vi.fn().mockResolvedValue({ relayOnly: false }),
  };
  const controller = new CallsController(calls as unknown as CallsService);
  return { controller, calls };
}

describe('CallsController route contract', () => {
  it('mintTurnCredentials is guarded (not @Public) and returns 200', () => {
    const meta = reflectRouteMeta(CallsController, 'mintTurnCredentials');
    expect(meta).toMatchObject({ isPublic: false, isAllowUnbound: false, httpCode: 200 });
  });

  it('invite is guarded and returns 202', () => {
    const meta = reflectRouteMeta(CallsController, 'invite');
    expect(meta).toMatchObject({ isPublic: false, isAllowUnbound: false, httpCode: 202 });
  });

  it('getSettings is guarded and returns 200', () => {
    const meta = reflectRouteMeta(CallsController, 'getSettings');
    expect(meta).toMatchObject({ isPublic: false, isAllowUnbound: false, httpCode: 200 });
  });

  it('updateSettings is guarded and returns 200', () => {
    const meta = reflectRouteMeta(CallsController, 'updateSettings');
    expect(meta).toMatchObject({ isPublic: false, isAllowUnbound: false, httpCode: 200 });
  });
});

describe('CallsController behaviour', () => {
  it('mintTurnCredentials returns the service response verbatim', async () => {
    const { controller, calls } = makeController();
    const result = await controller.mintTurnCredentials(auth, {});
    expect(result).toEqual(MOCK_TURN);
    expect(calls.mintTurnCredentials).toHaveBeenCalledWith(auth);
  });

  it('mintTurnCredentials propagates ForbiddenException (no accepted friends)', async () => {
    const { controller, calls } = makeController();
    calls.mintTurnCredentials.mockRejectedValue(new ForbiddenException('no accepted friends'));
    await expect(controller.mintTurnCredentials(auth, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('mintTurnCredentials does not pass credential to any logger', async () => {
    // The controller must be a thin pass-through: it cannot destructure or log the service result.
    // Verify the controller returns the object reference directly without accessing iceServers.
    let credentialAccessed = false;
    const proxyResponse = new Proxy(MOCK_TURN, {
      get(target, prop) {
        if (prop === 'iceServers') credentialAccessed = true;
        return Reflect.get(target, prop);
      },
    });
    const { calls: calls2 } = makeController();
    calls2.mintTurnCredentials.mockResolvedValue(proxyResponse);
    const controller2 = new CallsController(calls2 as unknown as CallsService);
    await controller2.mintTurnCredentials(auth, {});
    expect(credentialAccessed).toBe(false);
  });

  it('invite delegates to service and returns callId', async () => {
    const { controller, calls } = makeController();
    const result = await controller.invite(auth, FRIEND_ID, {
      conversationId: CONV_ID,
      media: 'audio',
    });
    expect(result).toEqual({ callId: CALL_ID });
    expect(calls.invite).toHaveBeenCalledWith(auth, FRIEND_ID, {
      conversationId: CONV_ID,
      media: 'audio',
    });
  });

  it('invite returns the same callId shape when service signals a gate failure (no oracle)', async () => {
    // The uniform-202 oracle guarantee lives in the service; the controller must be a pure pass-through.
    const { controller, calls } = makeController();
    const altId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    calls.invite.mockResolvedValue({ callId: altId });
    const result = await controller.invite(auth, FRIEND_ID, {
      conversationId: CONV_ID,
      media: 'audio',
    });
    expect(result).toEqual({ callId: altId });
  });

  it('getSettings returns service response verbatim', async () => {
    const { controller, calls } = makeController();
    const result = await controller.getSettings(auth);
    expect(result).toEqual({ relayOnly: true });
    expect(calls.getSettings).toHaveBeenCalledWith(auth);
  });

  it('updateSettings returns updated preference', async () => {
    const { controller, calls } = makeController();
    const result = await controller.updateSettings(auth, { relayOnly: false });
    expect(result).toEqual({ relayOnly: false });
    expect(calls.updateSettings).toHaveBeenCalledWith(auth, { relayOnly: false });
  });
});
