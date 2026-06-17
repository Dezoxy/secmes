import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiProperty } from '@nestjs/swagger';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import {
  type CreateInviteResponse,
  type InviteSummary,
  type MemberSummary,
} from '@argus/contracts';
import { TenantsService } from './tenants.service.js';
import { z } from 'zod';

class CreateInviteResponseDto {
  @ApiProperty({ format: 'uuid' }) inviteId!: string;
  @ApiProperty({ description: 'One-time plaintext token — returned once, never stored' })
  token!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

class InviteSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) acceptedAt!: string | null;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) revokedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class MemberSummaryDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ nullable: true, type: 'string' }) displayName!: string | null;
  @ApiProperty({ enum: ['admin', 'member'] }) role!: 'admin' | 'member';
}

const SetRoleBodySchema = z.object({ role: z.enum(['admin', 'member']) }).strict();

@ApiTags('tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  // ── Invites ──────────────────────────────────────────────────────────────────

  @Post('invites')
  @UseGuards(AdminGuard)
  @Throttle(perMinute(SENSITIVE_LIMITS.createInvite))
  @ApiOperation({
    summary: 'Create a single-use invite/registration code (admin only)',
    operationId: 'createInvite',
  })
  @ApiCreatedResponse({
    description: 'invite created; token returned once',
    type: CreateInviteResponseDto,
  })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async createInvite(@CurrentAuth() auth: VerifiedAuth): Promise<CreateInviteResponse> {
    return this.tenants.createInvite(auth);
  }

  @Get('invites')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'List active invites for the tenant (admin only)',
    operationId: 'listInvites',
  })
  @ApiOkResponse({ description: 'list of active invites', type: [InviteSummaryDto] })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  async listInvites(@CurrentAuth() auth: VerifiedAuth): Promise<InviteSummary[]> {
    const rows = await this.tenants.listInvites(auth);
    return rows.map((r) => ({
      id: r.id,
      expiresAt: r.expiresAt.toISOString(),
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  @Delete('invites/:id')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Revoke an invite (admin only)', operationId: 'revokeInvite' })
  @ApiNoContentResponse({ description: 'invite revoked' })
  @ApiNotFoundResponse({ description: 'invite not found or already used/revoked' })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  async revokeInvite(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.tenants.revokeInvite(auth, id);
  }

  // ── Members ──────────────────────────────────────────────────────────────────

  @Get('members')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'List active members of the tenant (admin only)',
    operationId: 'listMembers',
  })
  @ApiOkResponse({ description: 'list of active members', type: [MemberSummaryDto] })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  async listMembers(@CurrentAuth() auth: VerifiedAuth): Promise<MemberSummary[]> {
    const rows = await this.tenants.listMembers(auth);
    return rows as MemberSummary[];
  }

  @Patch('members/:userId/role')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Change a member's role (admin only)", operationId: 'setMemberRole' })
  @ApiNoContentResponse({ description: 'role updated' })
  @ApiNotFoundResponse({ description: 'user not found' })
  @ApiForbiddenResponse({ description: 'cannot remove the last admin' })
  async setMemberRole(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(SetRoleBodySchema)) body: z.infer<typeof SetRoleBodySchema>,
  ): Promise<void> {
    return this.tenants.setMemberRole(auth, userId, body.role);
  }

  @Delete('members/:userId')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Revoke a member (admin only, soft-delete)',
    operationId: 'revokeMember',
  })
  @ApiNoContentResponse({ description: 'member revoked' })
  @ApiNotFoundResponse({ description: 'user not found' })
  @ApiForbiddenResponse({ description: 'cannot remove the last admin' })
  async revokeMember(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.tenants.revokeMember(auth, userId);
  }
}
