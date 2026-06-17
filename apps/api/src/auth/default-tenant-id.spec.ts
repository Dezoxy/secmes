import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_TENANT_ID as BREAKGLASS_DEFAULT } from './breakglass.service.js';
import { DEFAULT_TENANT_ID as WEBAUTHN_DEFAULT } from './webauthn.service.js';

// Regression guard for a deploy-blocking bug: the DEFAULT_TENANT_ID sentinel must be a valid
// RFC-4122 UUID. The contracts validate every `tenantId` with `z.string().uuid()` (strict version +
// variant nibbles), and /me re-parses its response against that schema — so a sentinel that Postgres
// accepts but Zod rejects (e.g. the old 00000000-0000-0000-0000-000000000001) makes /me 500 for every
// user bound to the default workspace (breakglass + passkey), which neither the demo-mode E2E nor the
// random-UUID unit tests exercised.
describe('DEFAULT_TENANT_ID', () => {
  it('is a valid RFC-4122 UUID (passes the contracts z.string().uuid() used on /me)', () => {
    expect(() => z.string().uuid().parse(BREAKGLASS_DEFAULT)).not.toThrow();
  });

  it('is identical across the breakglass and webauthn services', () => {
    expect(BREAKGLASS_DEFAULT).toBe(WEBAUTHN_DEFAULT);
  });
});
