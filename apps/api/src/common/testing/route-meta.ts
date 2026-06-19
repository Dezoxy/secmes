import { RequestMethod, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_ALLOW_UNBOUND_KEY } from '../../auth/allow-unbound.decorator.js';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator.js';
import { PUBLIC_RATE_LIMIT_KEY } from '../../rate-limit/public-rate-limit.decorator.js';

// NestJS's built-in metadata keys (from @nestjs/common/constants). Inlined as literals because that
// subpath is not part of the package's public `exports` map under NodeNext — the string values are
// stable and asserted by route-meta.spec.ts against real @HttpCode/@UseGuards decorators.
const HTTP_CODE_METADATA = '__httpCode__';
const GUARDS_METADATA = '__guards__';
const METHOD_METADATA = 'method';

/**
 * The security-relevant decorator contract of a single controller route, read straight off its
 * metadata — NO Nest TestingModule, no HTTP. This is the "contract tier" of our controller specs:
 * it pins whether a route is public, what status code it returns, and which guards wrap it, so a
 * later edit that (say) flips a route to @Public() or drops an AdminGuard fails a fast unit test.
 *
 * Behaviour (what the handler body does with already-validated input) is covered separately by the
 * "behaviour tier" — direct instantiation with faked services. Param pipes (ZodValidationPipe /
 * ParseUUIDPipe) are deliberately NOT reflected here: they live in ROUTE_ARGS_METADATA keyed by
 * param index and don't run on a direct call, so validation stays covered by the @argus/contracts
 * schema tests and the pipes' own behaviour.
 */
export interface RouteMeta {
  /** @Public() — opts the route out of the global JwtAuthGuard (no bearer required). */
  isPublic: boolean;
  /** @AllowUnbound() — callable by an authenticated-but-not-yet-tenant-bound user. */
  isAllowUnbound: boolean;
  /** @PublicRateLimit() — opts a @Public route back into the IP-keyed throttler. */
  hasPublicRateLimit: boolean;
  /**
   * The EFFECTIVE success status the route returns: the @HttpCode(n) override if present, otherwise
   * Nest's verb default (POST → 201, every other verb → 200). Resolving the default here — rather than
   * reporting `undefined` — means the spec pins the real returned code, so changing a route's verb or
   * adding/removing @HttpCode is caught.
   */
  httpCode: number;
  /**
   * Guard classes from @UseGuards on the method AND class, merged — Nest runs both tiers, so a
   * method-level guard does not hide a class-level one. Order is not significant; assert membership.
   */
  guards: Type[];
}

const reflector = new Reflector();

/**
 * Reflect the route contract for `methodName` on `ControllerClass`. Throws if the method is missing
 * (a renamed handler should fail loudly, not silently report an empty contract).
 */
export function reflectRouteMeta(ControllerClass: Type, methodName: string): RouteMeta {
  const handler = (ControllerClass.prototype as Record<string, unknown>)[methodName];
  if (typeof handler !== 'function') {
    throw new Error(`reflectRouteMeta: ${ControllerClass.name} has no method "${methodName}"`);
  }
  const fn = handler as (...args: unknown[]) => unknown;
  const targets: [typeof fn, Type] = [fn, ControllerClass];
  const explicitCode = Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined;
  const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
  // No route decorator (@Get/@Post/…) means this is not a mapped route — or a route lost its verb.
  // Fail loudly rather than silently deriving a misleading default status. (RequestMethod.GET === 0,
  // so test against undefined, not falsiness.)
  if (verb === undefined) {
    throw new Error(
      `reflectRouteMeta: ${ControllerClass.name}.${methodName} has no HTTP route decorator (@Get/@Post/…)`,
    );
  }
  return {
    isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ?? false,
    isAllowUnbound: reflector.getAllAndOverride<boolean>(IS_ALLOW_UNBOUND_KEY, targets) ?? false,
    hasPublicRateLimit:
      reflector.getAllAndOverride<boolean>(PUBLIC_RATE_LIMIT_KEY, targets) ?? false,
    httpCode: explicitCode ?? (verb === RequestMethod.POST ? 201 : 200),
    guards: reflector.getAllAndMerge<Type[]>(GUARDS_METADATA, targets) ?? [],
  };
}
