import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type Me, MeSchema, UpdateProfileSchema } from '@argus/contracts';

import { AllowUnbound } from '../auth/allow-unbound.decorator.js';
import type { MaybeUnboundAuth, VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { Throttle } from '@nestjs/throttler';
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
            displayName: { type: 'string', nullable: true },
            avatarSeed: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['admin', 'member'] },
          },
          required: ['bound', 'userId', 'tenantId', 'argusId', 'displayName', 'avatarSeed', 'role'],
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async me(@CurrentAuth() auth: MaybeUnboundAuth): Promise<Me> {
    if (!auth.tenantId) return MeSchema.parse({ bound: false });

    const user = await this.users.getByAuth(auth as VerifiedAuth);
    if (!user) return MeSchema.parse({ bound: false });

    return MeSchema.parse({
      bound: true,
      userId: user.id,
      tenantId: auth.tenantId,
      argusId: user.argusId,
      displayName: user.displayName,
      avatarSeed: user.avatarSeed,
      role: user.role,
    });
  }

  /** Update the caller's display name and/or avatar seed. */
  @Put('me')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.updateProfile))
  @ApiOperation({ summary: 'Update own display name / avatar seed', operationId: 'updateMe' })
  @ApiNoContentResponse({ description: 'profile updated' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async updateMe(@CurrentAuth() auth: MaybeUnboundAuth, @Body() body: unknown): Promise<void> {
    if (!auth.tenantId) return;
    const dto = UpdateProfileSchema.parse(body);
    const user = await this.users.getByAuth(auth as VerifiedAuth);
    if (!user) return;
    await this.users.updateProfile({ tenantId: auth.tenantId, userId: user.id }, dto);
  }
}
