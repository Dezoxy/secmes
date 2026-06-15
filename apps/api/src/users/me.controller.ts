import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type Me, MeSchema } from '@argus/contracts';

import { AllowUnbound } from '../auth/allow-unbound.decorator.js';
import type { MaybeUnboundAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { UserService } from './user.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class MeController {
  constructor(private readonly users: UserService) {}

  /** The authenticated user. Returns `{ bound: false }` for unbound users (no tenant yet). */
  @Get('me')
  @AllowUnbound()
  @ApiOperation({ summary: 'Current authenticated user or unbound state', operationId: 'getMe' })
  @ApiOkResponse({
    description: 'user profile or unbound state',
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: { bound: { type: 'boolean', enum: [false] } },
          required: ['bound'],
        },
        {
          type: 'object',
          properties: {
            bound: { type: 'boolean', enum: [true] },
            userId: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string', format: 'uuid' },
            argusId: { type: 'string' },
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['admin', 'member'] },
            plan: {
              type: 'object',
              properties: {
                tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
                memberLimit: { type: 'integer', nullable: true },
                ssoEnabled: { type: 'boolean' },
                memberCount: { type: 'integer', minimum: 0 },
                subscriptionStatus: {
                  type: 'string',
                  enum: [
                    'active',
                    'trialing',
                    'past_due',
                    'canceled',
                    'incomplete',
                    'incomplete_expired',
                    'unpaid',
                    'paused',
                  ],
                  nullable: true,
                },
              },
              required: ['tier', 'memberLimit', 'ssoEnabled', 'memberCount', 'subscriptionStatus'],
            },
          },
          required: [
            'bound',
            'userId',
            'tenantId',
            'argusId',
            'email',
            'displayName',
            'role',
            'plan',
          ],
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async me(@CurrentAuth() auth: MaybeUnboundAuth): Promise<Me> {
    // auth.tenantId is null for unbound users (guard allows @AllowUnbound through).
    if (!auth.tenantId) return MeSchema.parse({ bound: false });

    const user = await this.users.getByAuth(auth as { sub: string; tenantId: string });
    if (!user) return MeSchema.parse({ bound: false });

    return MeSchema.parse({
      bound: true,
      userId: user.id,
      tenantId: auth.tenantId,
      argusId: user.argusId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      plan: user.plan,
    });
  }
}
