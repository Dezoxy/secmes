import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AdminAuditResponse, DeviceSummary } from '@argus/contracts';
import { AdminGuard } from '../auth/admin.guard.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { AdminService } from './admin.service.js';

class DeviceSummaryDto {
  @ApiProperty({ format: 'uuid' }) deviceId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ nullable: true, type: 'string' }) displayName!: string | null;
  @ApiProperty({ maxLength: 12, description: 'First 12 chars of the base64 signature public key' })
  signaturePublicKeyPrefix!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class AuditEventSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ maxLength: 64 }) eventType!: string;
  @ApiProperty({ nullable: true, type: 'string', maxLength: 256 }) actorSub!: string | null;
  @ApiProperty({ nullable: true, type: 'string', maxLength: 128 }) actorDisplayName!: string | null;
  @ApiProperty({ nullable: true, type: 'string', maxLength: 45 }) ip!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class AdminAuditResponseDto {
  @ApiProperty({ type: [AuditEventSummaryDto] }) events!: AuditEventSummaryDto[];
  @ApiProperty({ required: false, type: 'string' }) nextCursor?: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('devices')
  @ApiOperation({
    summary: 'List all devices in the tenant (admin only)',
    operationId: 'adminListDevices',
  })
  @ApiOkResponse({ description: 'list of registered devices', type: [DeviceSummaryDto] })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listDevices(@CurrentAuth() auth: VerifiedAuth): Promise<DeviceSummary[]> {
    return this.adminService.listDevices(auth);
  }

  @Delete('devices/:deviceId')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.adminDeviceRevoke))
  @ApiOperation({
    summary: 'Revoke a device (admin only) — hard-delete, cascades key packages',
    operationId: 'adminRevokeDevice',
  })
  @ApiNoContentResponse({ description: 'device revoked' })
  @ApiNotFoundResponse({ description: 'device not found' })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async revokeDevice(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ): Promise<void> {
    return this.adminService.revokeDevice(auth, deviceId);
  }

  @Get('audit')
  @ApiOperation({
    summary: 'List tenant audit events, newest first (admin only)',
    operationId: 'adminListAudit',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    description: 'Max 100, default 50',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Keyset cursor' })
  @ApiOkResponse({ description: 'paginated audit events', type: AdminAuditResponseDto })
  @ApiBadRequestResponse({ description: 'invalid cursor' })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listAudit(
    @CurrentAuth() auth: VerifiedAuth,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
    @Query('cursor') cursor?: string,
  ): Promise<AdminAuditResponse> {
    return this.adminService.listAudit(auth, limit, cursor);
  }
}
