import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import type { MeExport } from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { perDay, perHour, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { GdprService } from './gdpr.service.js';

// ---------------------------------------------------------------------------
// OpenAPI DTO — mirrors MeExportSchema from @argus/contracts.
// No ciphertext, keys, or message content is ever present.
// ---------------------------------------------------------------------------

class ExportPrivacySettingsDto {
  @ApiProperty() readReceipts!: boolean;
  @ApiProperty() typingIndicators!: boolean;
  @ApiProperty() linkPreviews!: boolean;
}

class ExportCallSettingsDto {
  @ApiProperty({ description: 'true = relay-only (default); false = direct P2P allowed' })
  relayOnly!: boolean;
}

class ExportProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty() argusId!: string;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarSeed!: string | null;
  @ApiProperty() role!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: ExportPrivacySettingsDto }) privacySettings!: ExportPrivacySettingsDto;
  @ApiProperty({ type: ExportCallSettingsDto }) callSettings!: ExportCallSettingsDto;
}

class ExportDeviceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class ExportConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class ExportMessageBucketDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty() count!: number;
  @ApiProperty({ format: 'date-time' }) firstAt!: string;
  @ApiProperty({ format: 'date-time' }) lastAt!: string;
}

class ExportMessageSummaryDto {
  @ApiProperty() totalCount!: number;
  @ApiProperty({ type: [ExportMessageBucketDto] }) byConversation!: ExportMessageBucketDto[];
}

class ExportAttachmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ description: 'server-issued blob reference' }) objectKey!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) expiresAt!: string | null;
}

class ExportPushSubscriptionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    description: 'first 40 chars of the push endpoint URL (service identification only)',
  })
  endpointPrefix!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class ExportAuditEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() eventType!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: {
      oneOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    description: 'non-sensitive metadata IDs only — never content or keys',
  })
  metadata!: Record<string, string | number | boolean | string[]> | null;
}

class ExportInviteDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) acceptedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) revokedAt!: string | null;
}

class ExportFriendshipDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', description: 'the other party in the friendship/request' })
  otherUserId!: string;
  @ApiProperty({ enum: ['pending', 'accepted'] }) status!: 'pending' | 'accepted';
  @ApiProperty({
    enum: ['incoming', 'outgoing'],
    nullable: true,
    description: 'set for pending requests only (null once accepted)',
  })
  direction!: 'incoming' | 'outgoing' | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) resolvedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) expiresAt!: string | null;
}

class MeExportDto {
  @ApiProperty({ enum: ['1'] }) schemaVersion!: '1';
  @ApiProperty({ format: 'date-time' }) exportedAt!: string;
  @ApiProperty() notice!: string;
  @ApiProperty({
    nullable: true,
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tenantId: { type: 'string', format: 'uuid' },
      argusId: { type: 'string' },
      displayName: { type: 'string', nullable: true },
      avatarSeed: { type: 'string', nullable: true },
      role: { type: 'string' },
      status: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      privacySettings: {
        type: 'object',
        properties: {
          readReceipts: { type: 'boolean' },
          typingIndicators: { type: 'boolean' },
          linkPreviews: { type: 'boolean' },
        },
        required: ['readReceipts', 'typingIndicators', 'linkPreviews'],
        additionalProperties: false,
      },
      callSettings: {
        type: 'object',
        properties: {
          relayOnly: { type: 'boolean' },
        },
        required: ['relayOnly'],
        additionalProperties: false,
      },
    },
    required: [
      'id',
      'tenantId',
      'argusId',
      'displayName',
      'avatarSeed',
      'role',
      'status',
      'createdAt',
      'privacySettings',
      'callSettings',
    ],
    additionalProperties: false,
  })
  profile!: ExportProfileDto | null;
  @ApiProperty({ type: [ExportDeviceDto] }) devices!: ExportDeviceDto[];
  @ApiProperty({ type: [ExportConversationDto] }) conversations!: ExportConversationDto[];
  @ApiProperty({ type: ExportMessageSummaryDto }) messageSummary!: ExportMessageSummaryDto;
  @ApiProperty({ type: [ExportAttachmentDto] }) attachments!: ExportAttachmentDto[];
  @ApiProperty({ type: [ExportPushSubscriptionDto] })
  pushSubscriptions!: ExportPushSubscriptionDto[];
  @ApiProperty({ type: [ExportAuditEventDto] }) auditEvents!: ExportAuditEventDto[];
  @ApiProperty({ type: [ExportInviteDto] }) invitesCreated!: ExportInviteDto[];
  @ApiProperty({ type: [ExportFriendshipDto] }) friendships!: ExportFriendshipDto[];
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** The literal value the caller must pass in X-Confirm-Delete to trigger account deletion. */
export const CONFIRM_DELETE_VALUE = 'my-account';

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class GdprController {
  constructor(private readonly gdpr: GdprService) {}

  /**
   * GDPR Art. 20 — data-portability export. Returns all METADATA the server holds about the
   * caller as a downloadable JSON file. Never returns ciphertext, content keys, or message
   * plaintext (the server is crypto-blind).
   *
   * Rate-limited to 2 per hour per user — the query is heavy and the endpoint should not be
   * used as a data-scraping vector.
   */
  @Get('me/export')
  @Throttle(perHour(SENSITIVE_LIMITS.exportMyData))
  @ApiOperation({
    summary: 'Export all account metadata (GDPR Art. 20)',
    operationId: 'exportMyData',
    description:
      'Returns a JSON snapshot of every piece of metadata this server holds about the ' +
      'authenticated user. Message content is end-to-end encrypted and is never included.',
  })
  @ApiOkResponse({ description: 'account data export', type: MeExportDto })
  async export(
    @CurrentAuth() auth: VerifiedAuth,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeExport> {
    const data = await this.gdpr.exportAccount(auth);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="argus-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return data;
  }

  /**
   * GDPR Art. 17 — right to erasure. Permanently and irrevocably deletes the caller's account
   * and all associated metadata. Sent message rows are pseudonymized (sender set to NULL) so
   * offline recipients can still fetch their entitled ciphertext. Encrypted attachment blobs are
   * deleted from object storage best-effort after the DB transaction.
   *
   * Requires the `X-Confirm-Delete: my-account` header to prevent accidental deletion via API
   * browsing tools. Rate-limited to 3 per day per user.
   *
   * Auth is passkey-only (Zitadel/OIDC decommissioned in Phase 6) — no external IdP step needed.
   * See docs/threat-models/gdpr.md §6 for the full deletion runbook.
   */
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(perDay(SENSITIVE_LIMITS.deleteAccount))
  @ApiOperation({
    summary: 'Delete account (GDPR Art. 17 — right to erasure)',
    operationId: 'deleteMyAccount',
    description:
      'Permanently deletes the authenticated user account and all associated metadata. ' +
      'Irreversible. Requires the `X-Confirm-Delete: my-account` header.',
  })
  @ApiHeader({
    name: 'X-Confirm-Delete',
    description: `Must be set to "${CONFIRM_DELETE_VALUE}" to confirm intentional deletion.`,
    required: true,
  })
  @ApiNoContentResponse({ description: 'account deleted' })
  async delete(
    @CurrentAuth() auth: VerifiedAuth,
    @Headers('x-confirm-delete') confirm: string | undefined,
  ): Promise<void> {
    if (confirm !== CONFIRM_DELETE_VALUE) {
      throw new BadRequestException(
        `X-Confirm-Delete header must be "${CONFIRM_DELETE_VALUE}" to delete your account`,
      );
    }
    await this.gdpr.deleteAccount(auth);
  }
}
