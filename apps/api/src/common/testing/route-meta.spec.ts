import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AllowUnbound } from '../../auth/allow-unbound.decorator.js';
import { Public } from '../../auth/public.decorator.js';
import { PublicRateLimit } from '../../rate-limit/public-rate-limit.decorator.js';
import { reflectRouteMeta } from './route-meta.js';

// A guard class is identified by reference, so a no-op CanActivate is enough to assert @UseGuards wiring.
class FixtureGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Controller('fixture')
class FixtureController {
  // A public, unbound, rate-limited POST that overrides the status to 202 — exercises every custom key.
  @Post('open')
  @Public()
  @AllowUnbound()
  @PublicRateLimit()
  @HttpCode(202)
  open(): void {}

  // A guarded GET with no @HttpCode override and no public markers — the default-protected shape.
  @Get('guarded')
  @UseGuards(FixtureGuard)
  guarded(): void {}

  // A POST with no @HttpCode — pins the verb-derived default (201).
  @Post('made')
  made(): void {}

  // A plain method with NO route decorator — reflectRouteMeta must reject it, not invent a status.
  notARoute(): void {}
}

describe('reflectRouteMeta', () => {
  it('reads the full public/unbound/rate-limit/httpCode contract off a route', () => {
    expect(reflectRouteMeta(FixtureController, 'open')).toEqual({
      isPublic: true,
      isAllowUnbound: true,
      hasPublicRateLimit: true,
      httpCode: 202,
      guards: [],
    });
  });

  it('reads guards and derives the GET default status (200) for a protected route', () => {
    expect(reflectRouteMeta(FixtureController, 'guarded')).toEqual({
      isPublic: false,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [FixtureGuard],
    });
  });

  it('derives the POST default status (201) when no @HttpCode override is present', () => {
    expect(reflectRouteMeta(FixtureController, 'made')).toMatchObject({
      httpCode: 201,
      guards: [],
    });
  });

  it('throws on a missing method so a renamed handler fails loudly', () => {
    expect(() => reflectRouteMeta(FixtureController, 'nope')).toThrow(/no method "nope"/);
  });

  it('throws when the method has no HTTP route decorator (not a mapped route)', () => {
    expect(() => reflectRouteMeta(FixtureController, 'notARoute')).toThrow(
      /no HTTP route decorator/,
    );
  });
});
