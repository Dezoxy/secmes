import { SetMetadata } from '@nestjs/common';

export const IS_ALLOW_UNBOUND_KEY = 'isAllowUnbound';

/** Opt a route into being callable by unbound users (no tenant binding yet). Use sparingly — only
 *  for the three paths that establish the binding: POST /tenants, POST /tenants/invites/accept, GET /me. */
export const AllowUnbound = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_ALLOW_UNBOUND_KEY, true);
