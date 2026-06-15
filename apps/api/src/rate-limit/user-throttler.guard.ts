import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { MaybeUnboundAuth } from '../auth/auth.service.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { COOKIE_NAME } from '../auth/session-token.service.js';
import { PUBLIC_RATE_LIMIT_KEY } from './public-rate-limit.decorator.js';

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
    // req.auth is set by JwtAuthGuard. For @AllowUnbound routes, tenantId may be null — use
    // `unbound:<sub>` so the limit is still identity-scoped (not IP), even before binding.
    const auth = req.auth as MaybeUnboundAuth | undefined;
    if (auth) {
      return Promise.resolve(
        auth.tenantId ? `u:${auth.tenantId}:${auth.sub}` : `unbound:${auth.sub}`,
      );
    }
    // For @PublicRateLimit() routes: key on the first 16 chars of the refresh cookie when present.
    // Each session gets its own bucket (NAT-safe; avoids throttling an entire office behind one IP).
    // 64 bits of prefix is ample for bucketing — the full token never leaves this process.
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const refreshCookie = cookies?.[COOKIE_NAME];
    if (refreshCookie && refreshCookie.length >= 16) {
      return Promise.resolve(`session:${refreshCookie.slice(0, 16)}`);
    }
    const ip = (req.ip as string | undefined) ?? 'unknown';
    return Promise.resolve(`ip:${ip}`);
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    // Skip non-HTTP (the WS gateway authenticates itself with a first-frame token) and @Public routes
    // (health/version) — the same exemptions the auth guard makes, so the two stay in lockstep.
    // Exception: @PublicRateLimit() opts a route back in (IP-keyed fallback, not identity-keyed).
    if (context.getType() !== 'http') return Promise.resolve(true);
    const handler = context.getHandler();
    const cls = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, cls]);
    if (!isPublic) return Promise.resolve(false);
    const hasPublicRateLimit = this.reflector.getAllAndOverride<boolean>(PUBLIC_RATE_LIMIT_KEY, [
      handler,
      cls,
    ]);
    return Promise.resolve(!hasPublicRateLimit);
  }
}
