import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

import { schema, withRouting } from '../db/index.js';
import { OIDC_CONFIG, OIDC_JWKS, type OidcConfig } from './auth.config.js';

export interface VerifiedAuth {
  /** OIDC subject — the user's external identity id. */
  sub: string;
  /** Tenant the request acts as — set from `user_tenant_index`, never from a JWT claim. */
  tenantId: string;
  /** Verified profile claims (present when the IdP grants email/profile scope). Used for JIT provisioning. */
  email?: string;
  name?: string;
}

/** What `verify()` returns before the guard narrows it. `tenantId: null` = unbound (no tenant yet). */
export interface MaybeUnboundAuth extends Omit<VerifiedAuth, 'tenantId'> {
  tenantId: string | null;
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

  /** Verify a bearer JWT and derive identity. Returns `tenantId: null` for unbound users (no binding yet).
   *  The guard enforces non-null for routes not decorated with `@AllowUnbound()`. */
  async verify(token: string): Promise<MaybeUnboundAuth> {
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

    // Optional verified profile claims (used for JIT provisioning). Trustworthy — they're inside
    // the signed token. `name` falls back to preferred_username.
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const name =
      typeof payload.name === 'string'
        ? payload.name
        : typeof payload.preferred_username === 'string'
          ? payload.preferred_username
          : undefined;

    // Tenant derivation: DB lookup on user_tenant_index (no RLS — this is a routing table).
    // `sub` comes from the IdP-signed token; the binding row is INSERT-only from app paths — both
    // sides are server-controlled. `null` = unbound (new user, no tenant created or accepted yet).
    const row = await withRouting((tx) =>
      tx
        .select({ tenantId: schema.userTenantIndex.tenantId })
        .from(schema.userTenantIndex)
        .where(eq(schema.userTenantIndex.sub, sub))
        .limit(1)
        .then((r) => r[0]),
    );

    return { sub, tenantId: row?.tenantId ?? null, email, name };
  }
}
