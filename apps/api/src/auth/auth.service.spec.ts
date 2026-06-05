import { UnauthorizedException } from '@nestjs/common';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type JWK,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import type { OidcConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';

const ISSUER = 'https://idp.test/secmes';
const AUDIENCE = 'secmes-api';
const TENANT = '11111111-1111-1111-1111-111111111111';
const SUB = 'user-sub-1';

describe('AuthService.verify', () => {
  let svc: AuthService;
  let signKey: CryptoKey;
  let otherKey: CryptoKey; // a different keypair → signature must fail

  async function mint(opts: {
    key?: CryptoKey;
    alg?: string;
    iss?: string;
    aud?: string;
    sub?: string;
    tenant?: string;
    omitTenant?: boolean;
    expiresInSec?: number;
    notBeforeInSec?: number;
  }): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (!opts.omitTenant) payload.tenant_id = opts.tenant ?? TENANT;
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: 'test-key' })
      .setIssuedAt(now)
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject(opts.sub ?? SUB)
      .setExpirationTime(now + (opts.expiresInSec ?? 300));
    if (opts.notBeforeInSec !== undefined) jwt.setNotBefore(now + opts.notBeforeInSec);
    return jwt.sign(opts.key ?? signKey);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair('ES256', { extractable: true });
    signKey = kp.privateKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'test-key', alg: 'ES256' };
    const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
    otherKey = (await generateKeyPair('ES256', { extractable: true })).privateKey;

    const cfg: OidcConfig = {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: 'local',
      tenantClaim: 'tenant_id',
      configured: true,
    };
    svc = new AuthService(cfg, jwks);
  });

  it('accepts a valid token and returns verified identity', async () => {
    const res = await svc.verify(await mint({}));
    expect(res).toEqual({ sub: SUB, tenantId: TENANT });
  });

  it('rejects a wrong audience', async () => {
    await expect(svc.verify(await mint({ aud: 'someone-else' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong issuer', async () => {
    await expect(svc.verify(await mint({ iss: 'https://evil.test' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    await expect(svc.verify(await mint({ expiresInSec: -60 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a not-yet-valid token (nbf in the future)', async () => {
    await expect(svc.verify(await mint({ notBeforeInSec: 600 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a bad signature (token signed by another key)', async () => {
    await expect(svc.verify(await mint({ key: otherKey }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a disallowed algorithm (HS256 — alg-confusion guard)', async () => {
    const hs = await new SignJWT({ tenant_id: TENANT })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUB)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a'.repeat(32)));
    await expect(svc.verify(hs)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing tenant claim', async () => {
    await expect(svc.verify(await mint({ omitTenant: true }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non-UUID tenant claim', async () => {
    await expect(svc.verify(await mint({ tenant: 'not-a-uuid' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a malformed token', async () => {
    await expect(svc.verify('not.a.jwt')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
