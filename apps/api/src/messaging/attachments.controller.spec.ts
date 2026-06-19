import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { reflectRouteMeta } from '../common/testing/route-meta.js';
import { AttachmentsController } from './attachments.controller.js';
import type { AttachmentsService } from './attachments.service.js';

// Contract tier: both grant routes are authenticated (none @Public, no extra guards). upload keeps the @Post
// default 201 (it registers a new blob slot); download is @HttpCode(200) (it mints a grant for an EXISTING
// object — pinning 200 guards the doc-vs-runtime drift this slice fixed). Behaviour tier: the controller is a
// thin relay — download forwards only the opaque objectKey (never a URL), and membership gating lives in the
// service (tested there). The presigned URLs the service returns are capabilities — never logged/stored.

const auth: VerifiedAuth = { sub: 'argusid:me', tenantId: '11111111-1111-1111-1111-111111111111' };
const CONV = '33333333-3333-3333-3333-333333333333';

function makeController() {
  const attachments = {
    createUploadGrant: vi
      .fn()
      .mockResolvedValue({ objectKey: 'tenant/obj', uploadUrl: 'https://put' }),
    createDownloadGrant: vi.fn().mockResolvedValue({ url: 'https://get' }),
  };
  return {
    controller: new AttachmentsController(attachments as unknown as AttachmentsService),
    attachments,
  };
}

describe('AttachmentsController route contract', () => {
  const ROUTES: ReadonlyArray<[string, number]> = [
    ['upload', 201], // @Post verb default — registers a new blob slot
    ['download', 200], // @HttpCode(200) — grant for an existing object
  ];

  it.each(ROUTES)('%s is authenticated with the expected status code', (method, httpCode) => {
    expect(reflectRouteMeta(AttachmentsController, method)).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode,
      guards: [],
    });
  });
});

describe('AttachmentsController behaviour', () => {
  it('upload forwards the validated grant request body', async () => {
    const { controller, attachments } = makeController();
    const body = { conversationId: CONV, byteSize: 1024 };
    const grant = await controller.upload(auth, body);
    expect(attachments.createUploadGrant).toHaveBeenCalledWith(auth, body);
    expect(grant).toEqual({ objectKey: 'tenant/obj', uploadUrl: 'https://put' });
  });

  it('download forwards only the opaque object key (not a URL)', async () => {
    const { controller, attachments } = makeController();
    const grant = await controller.download(auth, { objectKey: 'tenant/obj' });
    expect(attachments.createDownloadGrant).toHaveBeenCalledWith(auth, 'tenant/obj');
    expect(grant).toEqual({ url: 'https://get' });
  });
});
