import { SetMetadata } from '@nestjs/common';

export const PUBLIC_RATE_LIMIT_KEY = 'publicRateLimit';

/**
 * Apply rate limiting to a @Public() route. By default UserThrottlerGuard skips all public routes
 * (pre-auth flood is the edge's job). Marking a route with @PublicRateLimit() opts it back in —
 * the guard then uses the IP fallback tracker instead of the identity-keyed tracker.
 */
export const PublicRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_RATE_LIMIT_KEY, true);
