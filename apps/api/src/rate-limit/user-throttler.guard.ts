import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';

/**
 * Global rate-limit guard for AUTHENTICATED abuse. Keys on the VERIFIED account (`tenant:sub`) so a limit is
 * per-USER, not per-IP — NAT-safe (many users behind one IP aren't lumped together) and tenant-isolated (one
 * tenant can't exhaust another's budget). Registered AFTER `JwtAuthGuard`, which sets `req.auth` from the
 * verified token, so for every route this guard runs on `req.auth` is already present.
 *
 * Scope: it does NOT bound UNauthenticated request floods. `JwtAuthGuard` rejects a missing/invalid token
 * before this guard, so failed-auth requests never reach it. That's deliberate — a pre-auth IP throttle
 * would penalise legitimate NAT'd traffic (it can't distinguish an authed user from an attacker before auth
 * runs), and this API has no password endpoint (OIDC-delegated), so the un-throttled surface is a generic
 * HTTP flood, not a credential oracle. Unauthenticated-flood protection is the edge's job (Caddy rate_limit
 * / WAF — VM deploy track; see rate-limiting.md §6). The `ip:` fallback below is only a degradation default.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = req.auth as VerifiedAuth | undefined;
    const ip = (req.ip as string | undefined) ?? 'unknown';
    // Tenant + subject — never client-supplied; the verified token is the only identity source. The `ip:`
    // branch is a defensive default: for every route this guard runs on, `JwtAuthGuard` has already set
    // `req.auth`, so it is NOT the pre-auth control (that's the edge — see the class doc).
    return Promise.resolve(auth ? `u:${auth.tenantId}:${auth.sub}` : `ip:${ip}`);
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    // Skip non-HTTP (the WS gateway authenticates itself with a first-frame token) and @Public routes
    // (health/version) — the same exemptions the auth guard makes, so the two stay in lockstep.
    if (context.getType() !== 'http') return Promise.resolve(true);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return Promise.resolve(isPublic ?? false);
  }
}
