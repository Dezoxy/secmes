import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthService, type MaybeUnboundAuth, type VerifiedAuth } from './auth.service.js';
import { IS_ALLOW_UNBOUND_KEY } from './allow-unbound.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

// Global, deny-by-default. Every route requires a valid bearer JWT unless marked @Public().
// Bound routes also require a tenant binding — 403 if unbound, unless @AllowUnbound().
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // This global guard protects HTTP routes only. The WebSocket gateway authenticates itself with a
    // first-frame token (see realtime.gateway), so skip the 'ws' context — and ONLY 'ws'. Any other
    // future transport (e.g. an 'rpc'/microservice handler) falls through to the HTTP branch and fails
    // LOUDLY rather than being silently exempted; whoever adds one must re-evaluate this branch.
    if (ctx.getType() === 'ws') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; auth?: VerifiedAuth }>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    // verify() throws UnauthorizedException on any failure; identity comes from verified claims only.
    const auth: MaybeUnboundAuth = await this.auth.verify(header.slice('Bearer '.length));

    // Unbound check: a null tenantId means the user hasn't created or joined a tenant yet.
    // 403 for all routes that are not explicitly @AllowUnbound().
    if (auth.tenantId === null) {
      const isAllowUnbound = this.reflector.getAllAndOverride<boolean>(IS_ALLOW_UNBOUND_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);
      if (!isAllowUnbound) throw new ForbiddenException('not bound to a tenant');
    }

    // Safe cast: either tenantId is non-null (normal routes), or the route opted in to null
    // via @AllowUnbound and must handle it explicitly (checked via cast to MaybeUnboundAuth).
    req.auth = auth as VerifiedAuth;
    return true;
  }
}
