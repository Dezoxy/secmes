import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';

/**
 * Global rate-limit guard. Keys on the VERIFIED account (`tenant:sub`) so a limit is per-USER, not per-IP —
 * NAT-safe (many users behind one IP aren't lumped together) and tenant-isolated (one tenant can't exhaust
 * another's budget). Falls back to the IP when there's no verified auth (pre-auth / brute-force protection).
 * Registered as a global guard AFTER `JwtAuthGuard`, which sets `req.auth` from the verified token.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = req.auth as VerifiedAuth | undefined;
    const ip = (req.ip as string | undefined) ?? 'unknown';
    // Tenant + subject — never client-supplied; the verified token is the only identity source.
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
