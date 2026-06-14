import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import { DevicesService } from './devices.service.js';
import {
  EnrollmentApproveBodySchema,
  EnrollmentRegisterBodySchema,
  WithdrawDeviceBodySchema,
  type EnrollmentApproveBody,
  type EnrollmentRegisterBody,
  type WithdrawDeviceBody,
} from './devices.schemas.js';

// OpenAPI DTO classes — bounds mirror the Zod schemas so 42Crunch sees tight contracts.
class EnrollmentRegisterBodyDto {
  @ApiProperty({
    description: 'Public device fingerprint (QR/code) displayed by D2',
    maxLength: 512,
  })
  fingerprint!: string;

  @ApiProperty({
    description: "D2's own server device UUID (from POST /devices/me/key-packages)",
    format: 'uuid',
  })
  deviceId!: string;
}

class EnrollmentApproveBodyDto {
  @ApiProperty({ description: "D1's own server device UUID", format: 'uuid' })
  approvingDeviceId!: string;

  @ApiProperty({
    description: 'base64url Ed25519 enroll-approval proof from D1',
    maxLength: 256,
    pattern: '^[A-Za-z0-9_-]+$',
  })
  proof!: string;
}

class EnrollmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  requestingDeviceId!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  approvedByDeviceId!: string | null;

  @ApiProperty()
  fingerprint!: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'expired'] })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      "D1's registered signature public key (base64) — used by D2 to verify D1's key package",
  })
  approverSignaturePublicKey!: string | null;
}

class ConversationListDto {
  @ApiProperty({ type: [String], description: 'Conversation IDs the caller is a member of' })
  conversationIds!: string[];
}

class WithdrawDeviceBodyDto {
  @ApiProperty({
    description:
      "The device's Ed25519 signature public key (base64) — identifies which device to withdraw",
    maxLength: 512,
  })
  signaturePublicKey!: string;

  @ApiProperty({
    description:
      'base64url Ed25519 proof-of-possession: sign(argus-withdraw:v1\\n${spk}, signaturePrivateKey)',
    maxLength: 128,
    pattern: '^[A-Za-z0-9_-]+$',
  })
  proof!: string;
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller()
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post('devices/me/enrollment')
  @HttpCode(200)
  @Throttle(perMinute(SENSITIVE_LIMITS.enrollmentRegister))
  @ApiOperation({
    summary: "Register D2's pending enrollment request (D2 side)",
    operationId: 'registerEnrollment',
    description:
      'D2 publishes its public fingerprint to signal it wants to be linked. D1 is nudged via WebSocket and must approve via POST /devices/enrollments/:id/approve. Expires in 15 minutes.',
  })
  @ApiBody({ type: EnrollmentRegisterBodyDto })
  @ApiOkResponse({ type: EnrollmentDto })
  @ApiBadRequestResponse({ description: 'device not owned by this user' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async register(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(EnrollmentRegisterBodySchema)) body: EnrollmentRegisterBody,
  ): Promise<EnrollmentDto> {
    const row = await this.devices.registerEnrollment(auth, body.fingerprint, body.deviceId);
    return toDto(row);
  }

  @Get('devices/enrollments')
  @Throttle(perMinute(SENSITIVE_LIMITS.enrollmentList))
  @ApiOperation({
    summary: 'List enrollment requests for the authenticated user (D1 side)',
    operationId: 'listEnrollments',
    description: 'Returns non-expired enrollments. Default status filter is "pending".',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'approved', 'rejected'],
    description: 'Filter by status (default: pending)',
  })
  @ApiOkResponse({ type: [EnrollmentDto] })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async list(
    @CurrentAuth() auth: VerifiedAuth,
    @Query('status') rawStatus?: string,
  ): Promise<EnrollmentDto[]> {
    const VALID = ['pending', 'approved', 'rejected'] as const;
    if (rawStatus !== undefined && !(VALID as readonly string[]).includes(rawStatus)) {
      throw new BadRequestException(`status must be one of: ${VALID.join(', ')}`);
    }
    const status = rawStatus as (typeof VALID)[number] | undefined;
    const rows = await this.devices.listEnrollments(auth, status);
    return rows.map(toDto);
  }

  @Post('devices/enrollments/:id/approve')
  @HttpCode(200)
  @Throttle(perMinute(SENSITIVE_LIMITS.enrollmentApprove))
  @ApiOperation({
    summary: "D1 approves D2's enrollment (requires enroll-proof)",
    operationId: 'approveEnrollment',
    description:
      'Verifies an Ed25519 enroll-proof from D1 against its published signature public key. D2 is nudged via WebSocket on success. Any failure → opaque 404.',
  })
  @ApiParam({ name: 'id', description: 'Enrollment ID', format: 'uuid' })
  @ApiBody({ type: EnrollmentApproveBodyDto })
  @ApiOkResponse({ type: EnrollmentDto })
  @ApiNotFoundResponse({ description: 'enrollment not found, expired, or bad proof' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async approve(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(EnrollmentApproveBodySchema)) body: EnrollmentApproveBody,
  ): Promise<EnrollmentDto> {
    const row = await this.devices.approveEnrollment(auth, id, body.approvingDeviceId, body.proof);
    return toDto(row);
  }

  @Post('devices/enrollments/:id/reject')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.enrollmentApprove))
  @ApiOperation({
    summary: "D1 rejects D2's enrollment",
    operationId: 'rejectEnrollment',
    description: 'Idempotent. No proof required — rejection is non-escalating.',
  })
  @ApiParam({ name: 'id', description: 'Enrollment ID', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'enrollment not found or already resolved' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async reject(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.devices.rejectEnrollment(auth, id);
  }

  @Post('devices/me/withdraw')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.deviceWithdraw))
  @ApiOperation({
    summary: 'Permanently remove this device (legacy migration or explicit device removal)',
    operationId: 'withdrawDevice',
    description:
      "Deletes the caller's own device row identified by signaturePublicKey (cascades to key packages). Used during the pre-B2 → B2 identity migration to remove the old device row so the new composite-identity device is not published as provisional. Idempotent if the device is already gone.",
  })
  @ApiBody({ type: WithdrawDeviceBodyDto })
  @ApiNoContentResponse({ description: 'device withdrawn (or was already absent)' })
  @ApiBadRequestResponse({ description: 'invalid body' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async withdraw(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(WithdrawDeviceBodySchema)) body: WithdrawDeviceBody,
  ): Promise<void> {
    await this.devices.withdrawDevice(auth, body.signaturePublicKey, body.proof);
  }

  @Get('devices/me/conversations')
  @Throttle(perMinute(SENSITIVE_LIMITS.enrollmentConversationList))
  @ApiOperation({
    summary: "List the caller's conversation IDs (enrollment fan-out diff)",
    operationId: 'listMyConversations',
    description:
      'Returns conversation IDs the caller is a member of. Used by D1 after approving D2 to compute which conversations need an add-commit. Metadata only — no conversation content.',
  })
  @ApiOkResponse({ type: ConversationListDto })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listConversations(@CurrentAuth() auth: VerifiedAuth): Promise<ConversationListDto> {
    const conversationIds = await this.devices.listMyConversations(auth);
    return { conversationIds };
  }
}

function toDto(row: {
  id: string;
  requestingDeviceId: string;
  approvedByDeviceId: string | null;
  fingerprint: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  approverSignaturePublicKey?: string | null;
}): EnrollmentDto {
  return {
    id: row.id,
    requestingDeviceId: row.requestingDeviceId,
    approvedByDeviceId: row.approvedByDeviceId,
    fingerprint: row.fingerprint,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    approverSignaturePublicKey: row.approverSignaturePublicKey ?? null,
  };
}
