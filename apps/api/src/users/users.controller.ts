import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { UserDirectoryQuerySchema, type UserDirectoryQuery } from './user.schemas.js';
import { UserService } from './user.service.js';

class UserSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;
}

class UserLookupResultDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  argusId!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarSeed!: string | null;
}

const LookupQuerySchema = z.object({
  argusId: z.string().min(1).max(128),
});
type LookupQuery = z.infer<typeof LookupQuerySchema>;

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UserService,
    private readonly audit: AuditService,
  ) {}

  /** Directory of users in the caller's tenant (metadata only; RLS-scoped). */
  @Get()
  @ApiOperation({ summary: "List users in the caller's tenant", operationId: 'listUsers' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  })
  @ApiOkResponse({ type: [UserSummaryDto] })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async list(
    @CurrentAuth() auth: VerifiedAuth,
    @Query(new ZodValidationPipe(UserDirectoryQuerySchema)) query: UserDirectoryQuery,
  ): Promise<UserSummaryDto[]> {
    return this.users.list(auth.tenantId, query.limit);
  }

  /**
   * Exact-match lookup by argus-id. Returns 404 uniformly for not-found and inactive users
   * (no oracle — see discovery-by-argus-id.md).
   */
  @Get('lookup')
  @Throttle(perMinute(SENSITIVE_LIMITS.lookupUser))
  @ApiOperation({ summary: 'Look up a user by exact argus-id', operationId: 'lookupUser' })
  @ApiQuery({ name: 'argusId', required: true, schema: { type: 'string', maxLength: 128 } })
  @ApiOkResponse({ type: UserLookupResultDto })
  @ApiNotFoundResponse({ description: 'no active user with that argus-id' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async lookup(
    @CurrentAuth() auth: VerifiedAuth,
    @Query(new ZodValidationPipe(LookupQuerySchema)) query: LookupQuery,
  ): Promise<UserLookupResultDto> {
    const result = await this.users.lookupByArgusId(auth.tenantId, query.argusId);
    // Audit every lookup (found and not-found) — targetArgusId is pseudonymous, not PII.
    await this.audit.record(auth.tenantId, {
      eventType: 'users.lookup',
      actorSub: auth.sub,
      metadata: { targetArgusId: query.argusId, found: result !== null },
    });
    if (!result) throw new NotFoundException();
    return result;
  }
}
