import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

import { schema, withRouting } from '../db/index.js';
import { OIDC_CONFIG, OIDC_JWKS, type OidcConfig } from './auth.config.js';
import { SESSION_VERIFY_KEY } from './session-key.config.js';

export interface VerifiedAuth {
  /** Subject — OIDC sub for Zitadel tokens, "argusid:<argus_id>" for self-minted tokens. */
  sub: string;
  /** Tenant the request acts as — set from `user_tenant_index`, never from a JWT claim. */
  tenantId: string;
  /** Session ID from self-minted argus tokens (`sid` JWT claim). Absent for Zitadel tokens. */
  sid?: string;
  /**
   * Internal users.id UUID from self-minted argus tokens (`uid` JWT claim). Absent for Zitadel
   * tokens. Allows user-resolution by PK without relying on external_identity_id, which carries
   * Zitadel IDs incompatible with argusid:... subjects.
   */
  userId?: string;
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

// Argus self-minted token parameters — separate from Zitadel to keep the two paths hermetic.
// See docs/threat-models/session-tokens.md §dual-accept-verify.
const ARGUS_ISS = 'argus';
const ARGUS_AUD = 'argus-api';
const ARGUS_ALGS = ['EdDSA'];

@Injectable()
export class AuthService {
  constructor(
    @Inject(OIDC_CONFIG) private readonly cfg: OidcConfig,
    @Inject(OIDC_JWKS) private readonly jwks: JWTVerifyGetKey,
    @Inject(SESSION_VERIFY_KEY) private readonly argusVerifyKey: CryptoKey,
  ) {}

  /**
   * Verify a bearer JWT and derive identity. Returns `tenantId: null` for unbound users.
   *
   * Dual-accept mode (Phase 1 → Phase 6): tries the self-minted argus path first, then falls
   * back to Zitadel JWKS. Two completely separate jwtVerify calls — keys and issuer constraints
   * are never merged. See docs/threat-models/session-tokens.md §dual-accept-verify.
   */
  async verify(token: string): Promise<MaybeUnboundAuth> {
    let payload: Record<string, unknown> = {};
    let isArgusMinted = false;

    // Argus path: our own EdDSA JWT. Strict iss/aud/alg — no overlap with Zitadel.
    try {
      ({ payload } = await jwtVerify(token, this.argusVerifyKey, {
        issuer: ARGUS_ISS,
        audience: ARGUS_AUD,
        algorithms: ARGUS_ALGS,
        clockTolerance: 5,
      }));
      isArgusMinted = true;
    } catch {
      // Fall through to Zitadel path — no error surfaced on the intermediate failure.
    }

    // Zitadel fallback path (active until Phase 6 removes OIDC).
    if (!isArgusMinted) {
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
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) throw new UnauthorizedException('token missing sub');

    // sid — present only in argus-minted tokens (the session DB row id for revocation).
    const sid = isArgusMinted && typeof payload.sid === 'string' ? payload.sid : undefined;

    // uid — present only in argus-minted tokens (users.id UUID). Enables user lookup by PK instead
    // of by external_identity_id, which carries Zitadel IDs incompatible with argusid:... subjects.
    const userId = isArgusMinted && typeof payload.uid === 'string' ? payload.uid : undefined;

    // Optional verified profile claims (used for JIT provisioning from Zitadel tokens only).
    // Argus-minted tokens carry no IdP claims.
    const email = !isArgusMinted && typeof payload!.email === 'string' ? payload!.email : undefined;
    const name = !isArgusMinted
      ? typeof payload!.name === 'string'
        ? payload!.name
        : typeof payload!.preferred_username === 'string'
          ? payload!.preferred_username
          : undefined
      : undefined;

    // Tenant derivation: DB lookup on user_tenant_index (no RLS — this is a routing table).
    // `sub` comes from the verified token; the binding row is INSERT-only from app paths.
    // `null` = unbound (new user, no tenant created or accepted yet).
    const row = await withRouting((tx) =>
      tx
        .select({ tenantId: schema.userTenantIndex.tenantId })
        .from(schema.userTenantIndex)
        .where(eq(schema.userTenantIndex.sub, sub))
        .limit(1)
        .then((r) => r[0]),
    );

    return { sub, tenantId: row?.tenantId ?? null, sid, userId, email, name };
  }
}
