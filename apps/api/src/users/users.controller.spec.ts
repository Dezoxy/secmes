import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { UsersController } from './users.controller.js';
import type { UserService } from './user.service.js';

// Contract tier: the single lookup route is an authenticated 200 GET (not @Public, no extra guards).
// Behaviour tier: the controller collapses not-found/inactive into a uniform 404 (no existence oracle —
// discovery-by-argus-id.md), scopes the lookup to the verified tenant, and — critically — sanitises the
// raw query before it touches the audit log: a well-formed argus-id is recorded verbatim, but any other
// free-text (which could carry a secret or presigned URL) is replaced with a constant placeholder.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const VALID_ARGUS_ID = 'argus-abcdefghjkmnpqrs-acme';
const found = {
  userId: '33333333-3333-3333-3333-333333333333',
  argusId: VALID_ARGUS_ID,
  displayName: 'Alice',
  avatarSeed: null,
};

function makeController() {
  const users = { lookupByArgusId: vi.fn().mockResolvedValue(found) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    controller: new UsersController(
      users as unknown as UserService,
      audit as unknown as AuditService,
    ),
    users,
    audit,
  };
}

describe('UsersController route contract', () => {
  it('lookup is an authenticated 200 GET', () => {
    expect(reflectRouteMeta(UsersController, 'lookup')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [],
    });
  });
});

describe('UsersController behaviour', () => {
  it('returns the match scoped to the verified tenant and audits found=true', async () => {
    const { controller, users, audit } = makeController();
    const res = await controller.lookup(auth, { argusId: VALID_ARGUS_ID });
    expect(users.lookupByArgusId).toHaveBeenCalledWith(auth.tenantId, VALID_ARGUS_ID);
    expect(res).toBe(found);
    expect(audit.record).toHaveBeenCalledWith(auth.tenantId, {
      eventType: 'users.lookup',
      actorSub: auth.sub,
      metadata: { targetArgusId: VALID_ARGUS_ID, found: true },
    });
  });

  it('collapses not-found into a uniform 404 and audits found=false', async () => {
    const { controller, users, audit } = makeController();
    users.lookupByArgusId.mockResolvedValue(null);
    await expect(controller.lookup(auth, { argusId: VALID_ARGUS_ID })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).toHaveBeenCalledWith(
      auth.tenantId,
      expect.objectContaining({ metadata: { targetArgusId: VALID_ARGUS_ID, found: false } }),
    );
  });

  it('never logs a non-argus-id query verbatim (secrets/presigned URLs are masked)', async () => {
    const { controller, audit } = makeController();
    await controller.lookup(auth, { argusId: 'https://b2.example/obj?X-Amz-Signature=deadbeef' });
    expect(audit.record).toHaveBeenCalledWith(
      auth.tenantId,
      expect.objectContaining({ metadata: { targetArgusId: '<invalid-format>', found: true } }),
    );
  });
});
