import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ARGUS_SUB = 'argusid:argus-k7m2q9x4f3n8p1w5-otter';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';

// Mock the DB lookup so tests never need a real database. `withRouting` is called by `verify()` to
// resolve the sub→tenantId binding from `user_tenant_index`.
vi.mock('../db/index.js', () => ({
  withRouting: vi.fn(),
  schema: {
    userTenantIndex: { sub: 'sub', tenantId: 'tenant_id' },
  },
  eq: vi.fn((a, b) => ({ a, b })),
}));

import { withRouting } from '../db/index.js';

// Phase 6: the only accepted token is our self-minted argus EdDSA JWT. The Zitadel JWKS fallback was
// removed with OIDC — see docs/threat-models/phase-6-decommission.md.
describe('AuthService.verify', () => {
  let svc: AuthService;
  let argusSignKey: CryptoKey;
  let argusOtherKey: CryptoKey; // a different Ed25519 pair → signature must fail

  async function mintArgus(opts: {
    key?: CryptoKey;
    alg?: string;
    iss?: string;
    aud?: string;
    sub?: string;
    sid?: string;
    uid?: string;
    expiresInSec?: number;
    notBeforeInSec?: number;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ sid: opts.sid ?? SESSION_ID, uid: opts.uid ?? USER_ID })
      .setProtectedHeader({ alg: opts.alg ?? 'EdDSA', kid: 'argus-session-v1' })
      .setIssuedAt(now)
      .setIssuer(opts.iss ?? 'argus')
      .setAudience(opts.aud ?? 'argus-api')
      .setSubject(opts.sub ?? ARGUS_SUB)
      .setExpirationTime(now + (opts.expiresInSec ?? 300));
    if (opts.notBeforeInSec !== undefined) jwt.setNotBefore(now + opts.notBeforeInSec);
    return jwt.sign(opts.key ?? argusSignKey);
  }

  beforeAll(async () => {
    const argusKp = await generateKeyPair('EdDSA', { extractable: true });
    argusSignKey = argusKp.privateKey as CryptoKey;
    const argusVerifyKey = argusKp.publicKey as CryptoKey;
    argusOtherKey = (await generateKeyPair('EdDSA')).privateKey as CryptoKey;
    svc = new AuthService(argusVerifyKey);
  });

  it('accepts a valid argus-minted token and returns tenantId from the DB binding', async () => {
    vi.mocked(withRouting).mockResolvedValueOnce({ tenantId: TENANT });
    const res = await svc.verify(await mintArgus({}));
    expect(res).toMatchObject({
      sub: ARGUS_SUB,
      tenantId: TENANT,
      sid: SESSION_ID,
      userId: USER_ID,
    });
  });

  it('returns tenantId: null for an unbound user (no binding row)', async () => {
    vi.mocked(withRouting).mockResolvedValueOnce(undefined);
    const res = await svc.verify(await mintArgus({}));
    expect(res).toMatchObject({ sub: ARGUS_SUB, tenantId: null });
  });

  it('exposes sid and userId from the JWT payload', async () => {
    vi.mocked(withRouting).mockResolvedValueOnce({ tenantId: TENANT });
    const res = await svc.verify(await mintArgus({ sid: SESSION_ID, uid: USER_ID }));
    expect(res.sid).toBe(SESSION_ID);
    expect(res.userId).toBe(USER_ID);
  });

  it('rejects a wrong issuer', async () => {
    await expect(svc.verify(await mintArgus({ iss: 'https://evil.test' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong audience', async () => {
    await expect(svc.verify(await mintArgus({ aud: 'someone-else' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    await expect(svc.verify(await mintArgus({ expiresInSec: -60 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a not-yet-valid token (nbf in the future)', async () => {
    await expect(svc.verify(await mintArgus({ notBeforeInSec: 600 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed by a different key', async () => {
    await expect(svc.verify(await mintArgus({ key: argusOtherKey }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a disallowed algorithm (HS256 — alg-confusion guard)', async () => {
    const hs = await new SignJWT({ sid: SESSION_ID })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('argus')
      .setAudience('argus-api')
      .setSubject(ARGUS_SUB)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a'.repeat(32)));
    await expect(svc.verify(hs)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed token', async () => {
    await expect(svc.verify('not.a.jwt')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
