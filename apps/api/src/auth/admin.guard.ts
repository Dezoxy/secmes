import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { schema, withTenant } from '../db/index.js';
import type { VerifiedAuth } from './auth.service.js';

/** Requires the authenticated user to have `role = 'admin'` in their tenant. Must run after
 *  JwtAuthGuard (which sets req.auth). 403 for members, unbound requests never reach this guard. */
@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ auth?: VerifiedAuth }>();
    const auth = req.auth;
    if (!auth?.tenantId) throw new ForbiddenException('not bound to a tenant');

    const [user] = await withTenant(auth.tenantId, (tx) =>
      tx
        .select({ role: schema.users.role })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );

    if (user?.role !== 'admin') throw new ForbiddenException('admin role required');
    return true;
  }
}
