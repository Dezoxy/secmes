import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import {
  CreateDownloadGrantSchema,
  CreateUploadGrantSchema,
  MAX_ATTACHMENT_BYTES,
  type CreateDownloadGrant,
  type CreateUploadGrant,
} from './attachments.schemas.js';
import { AttachmentsService } from './attachments.service.js';

// OpenAPI bodies — bounds mirror the enforced Zod so the documented contract matches what we accept.
class CreateUploadGrantBody {
  @ApiProperty({
    format: 'uuid',
    description: 'the conversation this attachment belongs to (caller must be a member)',
  })
  conversationId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ATTACHMENT_BYTES,
    description: 'declared size of the ENCRYPTED blob in bytes',
  })
  byteSize!: number;
}

class UploadGrantDto {
  @ApiProperty({
    maxLength: 512,
    description: 'server-minted opaque object key (tenant-prefixed) — reference it in the message',
  })
  objectKey!: string;

  @ApiProperty({
    description:
      'short-lived presigned PUT URL — upload the ciphertext directly; never log or store it',
  })
  uploadUrl!: string;
}

class CreateDownloadGrantBody {
  @ApiProperty({
    maxLength: 512,
    description: 'the attachment object key (NOT a URL) from the decrypted message envelope',
  })
  objectKey!: string;
}

class DownloadGrantDto {
  @ApiProperty({
    description:
      'short-lived presigned GET URL — download the ciphertext directly; never log or store it',
  })
  url!: string;
}

// E2EE attachment grants. The server only mints short-lived presigned URLs for an S3-compatible blob store
// and tracks metadata (object key + size + uploader); it never sees the blob bytes or the content key (which
// rides inside the E2E MLS message). Both grants are membership-gated.
@ApiTags('messaging')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @Throttle(perMinute(SENSITIVE_LIMITS.uploadGrant))
  @ApiOperation({
    summary: 'Mint an upload grant for an encrypted attachment (member-only)',
    operationId: 'createAttachmentUploadGrant',
  })
  @ApiBody({ type: CreateUploadGrantBody })
  @ApiCreatedResponse({ type: UploadGrantDto })
  @ApiBadRequestResponse({ description: 'invalid body, or byteSize exceeds the limit' })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async upload(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(CreateUploadGrantSchema)) body: CreateUploadGrant,
  ): Promise<UploadGrantDto> {
    return this.attachments.createUploadGrant(auth, body);
  }

  @Post('download-url')
  @Throttle(perMinute(SENSITIVE_LIMITS.downloadGrant))
  @ApiOperation({
    summary: 'Mint a download grant for an encrypted attachment (member-only)',
    operationId: 'createAttachmentDownloadGrant',
  })
  @ApiBody({ type: CreateDownloadGrantBody })
  @ApiOkResponse({ type: DownloadGrantDto })
  @ApiBadRequestResponse({ description: 'invalid body' })
  @ApiNotFoundResponse({
    description: 'attachment not found or caller is not a member of its conversation',
  })
  @ApiResponse({ status: 413, description: 'the stored blob exceeds the size limit' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async download(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(CreateDownloadGrantSchema)) body: CreateDownloadGrant,
  ): Promise<DownloadGrantDto> {
    return this.attachments.createDownloadGrant(auth, body.objectKey);
  }
}
