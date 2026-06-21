import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { OLDEST_RETAINED_EPOCH_HEADER } from '@argus/contracts';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
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
  CommitBodySchema,
  CreateConversationSchema,
  ListCommitsQuerySchema,
  ListMessagesQuerySchema,
  SendMessageSchema,
  type CommitBody,
  type CreateConversation,
  type ListCommitsQuery,
  type ListMessagesQuery,
  type SendMessage,
} from './messaging.schemas.js';
import { type FetchedCommit } from './messaging.service.js';

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

  @ApiProperty({
    description:
      'true = 1:1 direct conversation; false = group. Explicit: the server cannot infer this from the initial solo member list.',
  })
  isDirect!: boolean;
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

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 256,
    description:
      'opaque keyset cursor for this message — echo as `after` to resume strictly after it (prune-safe)',
  })
  cursor?: string;
}

class CommitWelcomeBodyDto {
  @ApiProperty({ format: 'uuid' })
  recipientUserId!: string;
  @ApiProperty({ format: 'uuid' })
  recipientDeviceId!: string;
  @ApiProperty({
    description: 'HPKE-sealed MLS Welcome (base64)',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  welcome!: string;
  @ApiProperty({
    description: 'Serialized RatchetTree (base64)',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  ratchetTree!: string;
}

class CommitBodyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'client-generated id; idempotency key per sender+epoch',
  })
  clientCommitId!: string;
  @ApiProperty({
    description: 'MLS epoch at which this commit was staged (server slot key)',
    minimum: 0,
  })
  epoch!: number;
  @ApiProperty({
    description: 'opaque base64 mls_private_message commit frame — server never decrypts',
    maxLength: 65536,
    pattern: BASE64_PATTERN,
  })
  commit!: string;
  @ApiProperty({
    type: [CommitWelcomeBodyDto],
    description: 'one Welcome per added member device (max 64)',
    maxItems: 64,
  })
  welcomes!: CommitWelcomeBodyDto[];
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'declared added user ids (max 32)',
    maxItems: 32,
  })
  addedUserIds!: string[];
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'declared removed user ids (max 32)',
    maxItems: 32,
  })
  removedUserIds!: string[];
}

class CommitResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ minimum: 0 })
  epoch!: number;
  @ApiProperty({ description: 'true if own idempotent retry matched an existing commit' })
  deduplicated!: boolean;
}

class FetchedCommitDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ format: 'uuid', description: 'client-generated idempotency key for this commit' })
  clientCommitId!: string;
  @ApiProperty({ minimum: 0 })
  epoch!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'null after GDPR erasure',
  })
  senderUserId!: string | null;
  @ApiProperty({
    description: 'opaque base64 mls_private_message commit frame — server never decrypts',
  })
  commit!: string;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

class MessagePageDto {
  @ApiProperty({ type: [FetchedMessageDto] })
  messages!: FetchedMessageDto[];

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    format: 'uuid',
    description:
      'LEGACY page cursor (last message id) for older clients; null when not a full page. New clients page off each per-message prune-safe cursor instead.',
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
    return this.messaging.createConversation(auth, body.memberUserIds, body.isDirect);
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

  @Post(':conversationId/commits')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit a staged MLS membership commit to win the epoch slot',
    operationId: 'postCommit',
    description:
      'First POST for a given epoch wins (200). Concurrent POST at the same epoch loses (409). Own idempotent retry returns 200 deduplicated:true. The `commit` field is opaque — the server never decrypts it.',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiBody({ type: CommitBodyDto })
  @ApiOkResponse({ type: CommitResultDto, description: '200 on first win or own idempotent retry' })
  @ApiBadRequestResponse({ description: 'invalid body or user not provisioned' })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiConflictResponse({
    description: 'epoch slot already occupied by another member (409 — rebase and retry)',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async postCommit(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body(new ZodValidationPipe(CommitBodySchema)) body: CommitBody,
  ): Promise<CommitResultDto> {
    return this.messaging.postCommit(auth, conversationId, body);
  }

  @Get(':conversationId/commits')
  @ApiOperation({
    summary: "Drain a conversation's commits after a given epoch (member-only)",
    operationId: 'listCommits',
    description:
      'Returns commits in epoch-ascending order. Pass the current local epoch as `afterEpoch` to fetch only commits not yet applied. Clients must call this on connect and on every `commit` WS event.',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiQuery({
    name: 'afterEpoch',
    required: false,
    schema: { type: 'integer', minimum: 0, default: 0 },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
  })
  @ApiOkResponse({
    type: [FetchedCommitDto],
    headers: {
      [OLDEST_RETAINED_EPOCH_HEADER]: {
        description:
          'Oldest commit epoch the server still retains for this conversation (metadata only — never the commit blob). Omitted when the conversation has no commits. A client whose local epoch is below this value has lost a pruned commit it can never fetch (sync-lost).',
        schema: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listCommits(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query(new ZodValidationPipe(ListCommitsQuerySchema)) query: ListCommitsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FetchedCommit[]> {
    const { commits, oldestRetainedEpoch } = await this.messaging.listCommits(
      auth,
      conversationId,
      query,
    );
    // Surface the oldest retained epoch as a header so stale PWAs that validate the body as a bare
    // FetchedCommit[] (CommitPageSchema) keep working; updated clients read it to detect sync-lost.
    if (oldestRetainedEpoch !== null) {
      res.setHeader(OLDEST_RETAINED_EPOCH_HEADER, String(oldestRetainedEpoch));
    }
    return commits;
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
    schema: { type: 'string', maxLength: 256 },
    description:
      "exclusive cursor — a message's opaque `cursor` from a prior page (prune-safe), or a legacy message id",
  })
  @ApiOkResponse({
    type: MessagePageDto,
    description: 'a page of ciphertext messages (each with its own cursor) + a legacy page cursor',
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

  @Get(':conversationId/members')
  @ApiOperation({
    summary: 'List identity metadata for conversation members (member-only)',
    operationId: 'listConversationMembers',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
          argusId: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          avatarSeed: { type: 'string', nullable: true },
        },
        required: ['userId', 'argusId', 'displayName', 'avatarSeed'],
      },
    },
  })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listConversationMembers(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<
    Array<{
      userId: string;
      argusId: string;
      displayName: string | null;
      avatarSeed: string | null;
    }>
  > {
    return this.messaging.getConversationMembers(auth, conversationId);
  }
}
