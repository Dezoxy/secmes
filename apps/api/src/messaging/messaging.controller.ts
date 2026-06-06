import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MessagingService } from './messaging.service.js';
import {
  CreateConversationSchema,
  ListMessagesQuerySchema,
  SendMessageSchema,
  type CreateConversation,
  type ListMessagesQuery,
  type SendMessage,
} from './messaging.schemas.js';

const BASE64_PATTERN = '^[A-Za-z0-9+/]+={0,2}$';

// OpenAPI bodies — bounds mirror the enforced Zod so the documented contract matches what we accept.
class CreateConversationBody {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'other participant user ids (the caller is added automatically); 1–256',
    minItems: 1,
    maxItems: 256,
  })
  memberUserIds!: string[];
}

class SendMessageBody {
  @ApiProperty({ format: 'uuid', description: 'client-generated id; idempotency key per sender' })
  clientMessageId!: string;

  @ApiProperty({
    description: 'opaque base64 MLS ciphertext — the server never decrypts it',
    maxLength: 65536,
    pattern: BASE64_PATTERN,
  })
  ciphertext!: string;

  @ApiProperty({ description: 'AEAD/version tag, e.g. "MLS_1.0"', maxLength: 64 })
  alg!: string;

  @ApiProperty({ description: 'MLS epoch (non-negative)', minimum: 0 })
  epoch!: number;

  @ApiProperty({
    required: false,
    description: 'optional object key of an uploaded ENCRYPTED blob (not a URL)',
    maxLength: 512,
  })
  attachmentObjectKey?: string;
}

class CreatedConversationDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;
}

class SentMessageDto {
  @ApiProperty({ format: 'uuid' })
  messageId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ description: 'true if an idempotent retry matched an existing message' })
  deduplicated!: boolean;
}

class FetchedMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

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

class MessagePageDto {
  @ApiProperty({ type: [FetchedMessageDto] })
  messages!: FetchedMessageDto[];

  @ApiProperty({
    required: false,
    nullable: true,
    format: 'uuid',
    description: 'pass as `after` to fetch the next page; null when no more',
  })
  nextCursor!: string | null;
}

@ApiTags('messaging')
@ApiBearerAuth()
@Controller('conversations')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a conversation with the caller + members',
    operationId: 'createConversation',
  })
  @ApiBody({ type: CreateConversationBody })
  @ApiCreatedResponse({ type: CreatedConversationDto })
  @ApiBadRequestResponse({
    description: 'invalid body, or a member id is not a user in this tenant',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async createConversation(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(CreateConversationSchema)) body: CreateConversation,
  ): Promise<CreatedConversationDto> {
    return this.messaging.createConversation(auth, body.memberUserIds);
  }

  @Post(':conversationId/messages')
  @HttpCode(200) // idempotent send: a retry returns the existing message, so 200 (not 201) is honest
  @ApiOperation({
    summary: 'Send (store) a ciphertext message to a conversation',
    operationId: 'sendMessage',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiBody({ type: SendMessageBody })
  @ApiOkResponse({ type: SentMessageDto })
  @ApiBadRequestResponse({ description: 'invalid body, or user not provisioned' })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async sendMessage(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body(new ZodValidationPipe(SendMessageSchema)) body: SendMessage,
  ): Promise<SentMessageDto> {
    return this.messaging.sendMessage(auth, conversationId, body);
  }

  @Get(':conversationId/messages')
  @ApiOperation({
    summary: "List a conversation's ciphertext messages (member-only, paginated)",
    operationId: 'listMessages',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
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
  @ApiOkResponse({
    type: MessagePageDto,
    description: 'a page of ciphertext messages + next cursor',
  })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listMessages(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query(new ZodValidationPipe(ListMessagesQuerySchema)) query: ListMessagesQuery,
  ): Promise<MessagePageDto> {
    return this.messaging.listMessages(auth, conversationId, query);
  }
}
