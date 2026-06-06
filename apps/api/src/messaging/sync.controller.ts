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
import { ListMessagesQuerySchema, type ListMessagesQuery } from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

class SyncedMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'which conversation this message belongs to' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  senderUserId!: string;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ description: 'opaque base64 MLS ciphertext — the server never decrypts it' })
  ciphertext!: string;

  @ApiProperty({ description: 'AEAD/version tag' })
  alg!: string;

  @ApiProperty({ description: 'MLS epoch' })
  epoch!: number;

  @ApiProperty({
    required: false,
    nullable: true,
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
    required: false,
    nullable: true,
    format: 'uuid',
    description: 'pass as `after` to fetch the next page; null when caught up',
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
    schema: { type: 'string', format: 'uuid' },
    description: 'exclusive cursor — a message id (use the previous page nextCursor)',
  })
  @ApiOkResponse({ type: SyncPageDto, description: 'interleaved messages + next cursor' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async sync(
    @CurrentAuth() auth: VerifiedAuth,
    @Query(new ZodValidationPipe(ListMessagesQuerySchema)) query: ListMessagesQuery,
  ): Promise<SyncPageDto> {
    return this.messaging.syncMessages(auth, query);
  }
}
