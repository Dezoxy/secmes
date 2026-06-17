import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type Me, type UpdateProfile, MeSchema, UpdateProfileSchema } from '@argus/contracts';

import { AllowUnbound } from '../auth/allow-unbound.decorator.js';
import type { MaybeUnboundAuth, VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { Throttle } from '@nestjs/throttler';
import { UserService } from './user.service.js';

class UpdateProfileBody {
  @ApiProperty({
    required: false,
    description: 'new display name (1–64 chars, trimmed)',
    minLength: 1,
    maxLength: 64,
  })
  displayName?: string;

  @ApiProperty({
    required: false,
    description: 'aesthetic seed token for deterministic avatar generation (≤64 chars)',
    maxLength: 64,
  })
  avatarSeed?: string;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class MeController {
  constructor(
    private readonly users: UserService,
    private readonly audit: AuditService,
  ) {}

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
            isBreakglass: { type: 'boolean' },
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
      isBreakglass: user.displayName === 'breakglass-admin' || undefined,
    });
  }

  /** Update the caller's display name and/or avatar seed. */
  @Put('me')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.updateProfile))
  @ApiOperation({ summary: 'Update own display name / avatar seed', operationId: 'updateMe' })
  @ApiBody({ type: UpdateProfileBody })
  @ApiNoContentResponse({ description: 'profile updated' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async updateMe(
    @CurrentAuth() auth: MaybeUnboundAuth,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfile,
  ): Promise<void> {
    if (!auth.tenantId) return;
    const user = await this.users.getByAuth(auth as VerifiedAuth);
    if (!user) return;
    // Breakglass admin is identified solely by displayName sentinel; silently no-op
    // profile edits so the name stays immutable without revealing account status.
    if (user.displayName === 'breakglass-admin') return;
    await this.users.updateProfile({ tenantId: auth.tenantId, userId: user.id }, dto);
    // Audit which fields were changed — never log the values themselves.
    const fieldsUpdated = [
      ...(dto.displayName !== undefined ? (['displayName'] as const) : []),
      ...(dto.avatarSeed !== undefined ? (['avatarSeed'] as const) : []),
    ];
    if (fieldsUpdated.length > 0) {
      await this.audit.record(auth.tenantId, {
        eventType: 'users.profile_updated',
        actorSub: (auth as VerifiedAuth).sub,
        metadata: { fieldsUpdated },
      });
    }
  }
}
