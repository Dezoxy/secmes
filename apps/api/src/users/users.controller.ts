import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UserService) {}

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
}
