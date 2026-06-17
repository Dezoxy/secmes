import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
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

    // For Argus-minted tokens the access JWT carries a `sid` claim (auth_sessions.id). Check that
    // the session row is still active — this closes the 10-minute access-token window that would
    // otherwise survive a rotate() call (rotate() sets revoked_at on the refresh chain but stateless
    // JWTs keep working until expiry without this check). Only admin-endpoint overhead; regular user
    // endpoints skip this check entirely.
    if (auth.sid) {
      const [session] = await withTenant(auth.tenantId, (tx) =>
        tx
          .select({ revokedAt: schema.authSessions.revokedAt })
          .from(schema.authSessions)
          .where(eq(schema.authSessions.id, auth.sid!))
          .limit(1),
      );
      if (!session || session.revokedAt !== null) {
        throw new UnauthorizedException('session revoked');
      }
    }

    const [user] = await withTenant(auth.tenantId, (tx) =>
      tx
        .select({ role: schema.users.role })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, auth.tenantId),
            auth.userId
              ? eq(schema.users.id, auth.userId)
              : eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );

    if (user?.role !== 'admin') throw new ForbiddenException('admin role required');
    return true;
  }
}
