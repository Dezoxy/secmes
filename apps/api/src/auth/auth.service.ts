import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

import { asTenantId } from '../db/index.js';
import { OIDC_CONFIG, OIDC_JWKS, type OidcConfig } from './auth.config.js';

export interface VerifiedAuth {
  /** OIDC subject — the user's external identity id. */
  sub: string;
  /** Tenant the request acts as, from a VERIFIED claim only. */
  tenantId: string;
}

// Asymmetric only. Excludes `none` and HS* (an HS256 token signed with the public key would
// otherwise pass — the classic alg-confusion attack).
const ALLOWED_ALGS = ['RS256', 'ES256', 'EdDSA'];

@Injectable()
export class AuthService {
  constructor(
    @Inject(OIDC_CONFIG) private readonly cfg: OidcConfig,
    @Inject(OIDC_JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {}

  /** Verify a bearer JWT and return identity from verified claims. Throws 401 on any failure. */
  async verify(token: string): Promise<VerifiedAuth> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        algorithms: ALLOWED_ALGS,
        clockTolerance: 5,
      }));
    } catch {
      // Never surface the token or the underlying jose error detail.
      throw new UnauthorizedException('invalid token');
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) throw new UnauthorizedException('token missing sub');

    // Only a single string claim is accepted. Array / multi-valued claims (some IdPs emit them)
    // fall through to 401 by design — do NOT add array handling and silently accept the first element.
    const claim = payload[this.cfg.tenantClaim];
    if (typeof claim !== 'string') throw new UnauthorizedException('token missing tenant claim');
    try {
      return { sub, tenantId: asTenantId(claim) };
    } catch {
      throw new UnauthorizedException('invalid tenant claim');
    }
  }
}
