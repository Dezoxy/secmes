import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { SyncQuerySchema, type SyncQuery } from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

class SyncedMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'which conversation this message belongs to' })
  conversationId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null when the sender has exercised GDPR erasure',
  })
  senderUserId!: string | null;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ description: 'opaque base64 MLS ciphertext — the server never decrypts it' })
  ciphertext!: string;

  @ApiProperty({ description: 'AEAD/version tag' })
  alg!: string;

  @ApiProperty({ description: 'MLS epoch' })
  epoch!: number;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    maxLength: 512,
    description: 'object key of an encrypted attachment',
  })
  attachmentObjectKey!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

class SyncPageDto {
  @ApiProperty({ type: [SyncedMessageDto] })
  messages!: SyncedMessageDto[];

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    maxLength: 256,
    description:
      'opaque resume cursor at the last message of this page — persist it; pass as `after` to ' +
      'continue or resume later. Keep paging while you receive a full page. Null only on an empty page.',
  })
  nextCursor!: string | null;
}

@ApiTags('messaging')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({
    summary: "Catch up on messages across all the caller's conversations since a cursor",
    operationId: 'sync',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  })
  @ApiQuery({
    name: 'after',
    required: false,
    schema: { type: 'string', maxLength: 256 },
    description: 'opaque cursor — echo the previous page nextCursor',
  })
  @ApiOkResponse({ type: SyncPageDto, description: 'interleaved messages + next cursor' })
  @ApiBadRequestResponse({ description: 'malformed cursor' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async sync(
    @CurrentAuth() auth: VerifiedAuth,
    @Query(new ZodValidationPipe(SyncQuerySchema)) query: SyncQuery,
  ): Promise<SyncPageDto> {
    return this.messaging.syncMessages(auth, query);
  }
}
