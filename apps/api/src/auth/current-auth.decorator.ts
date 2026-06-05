import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { VerifiedAuth } from './auth.service.js';

/** Inject the verified `{ sub, tenantId }` the guard attached to the request. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VerifiedAuth =>
    ctx.switchToHttp().getRequest<{ auth: VerifiedAuth }>().auth,
);
