import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';

import { schema, withRouting } from '../db/index.js';
import { SESSION_VERIFY_KEY } from './session-key.config.js';

export interface VerifiedAuth {
  /** Subject — "argusid:<argus_id>" for self-minted tokens (the only accepted token type). */
  sub: string;
  /** Tenant the request acts as — set from `user_tenant_index`, never from a JWT claim. */
  tenantId: string;
  /** Session ID from the self-minted argus token (`sid` JWT claim) — used for revocation. */
  sid?: string;
  /**
   * Internal users.id UUID from the self-minted argus token (`uid` JWT claim). Allows
   * user-resolution by PK.
   */
  userId?: string;
  /**
   * Vestigial IdP profile claims. Always `undefined` now that OIDC is gone (Phase 6) — `verify()`
   * never populates them. The legacy `createTenant`/`acceptInvite` paths still reference them and are
   * removed in Phase 6 PR2, at which point these fields go too. Do not start populating them.
   */
  email?: string;
  name?: string;
}

/** What `verify()` returns before the guard narrows it. `tenantId: null` = unbound (no tenant yet). */
export interface MaybeUnboundAuth extends Omit<VerifiedAuth, 'tenantId'> {
  tenantId: string | null;
}

// Argus self-minted token parameters. EdDSA only — excludes `none` and HS* (an HS256 token signed with the
// public key would otherwise pass — the classic alg-confusion attack).
const ARGUS_ISS = 'argus';
const ARGUS_AUD = 'argus-api';
const ARGUS_ALGS = ['EdDSA'];

@Injectable()
export class AuthService {
  constructor(@Inject(SESSION_VERIFY_KEY) private readonly argusVerifyKey: CryptoKey) {}

  /**
   * Verify a bearer JWT and derive identity. Returns `tenantId: null` for unbound users.
   *
   * Single path (Phase 6): the only accepted token is our self-minted argus EdDSA JWT, verified with
   * our own key under strict iss/aud/alg. Any other token is rejected. The Zitadel JWKS fallback was
   * removed when OIDC was decommissioned — see docs/threat-models/phase-6-decommission.md.
   */
  async verify(token: string): Promise<MaybeUnboundAuth> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, this.argusVerifyKey, {
        issuer: ARGUS_ISS,
        audience: ARGUS_AUD,
        algorithms: ARGUS_ALGS,
        clockTolerance: 5,
      }));
    } catch {
      // Never surface the token or the underlying jose error detail. Fail closed.
      throw new UnauthorizedException('invalid token');
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) throw new UnauthorizedException('token missing sub');

    // sid — the session DB row id, for revocation.
    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    // uid — users.id UUID, enables user lookup by PK.
    const userId = typeof payload.uid === 'string' ? payload.uid : undefined;

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

    return { sub, tenantId: row?.tenantId ?? null, sid, userId };
  }
}
