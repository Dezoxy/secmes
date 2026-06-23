import {
  Body,
  Controller,
  Delete,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
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

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  DeliverWelcomeSchema,
  ListWelcomesQuerySchema,
  WelcomeProofQuerySchema,
  type DeliverWelcome,
  type ListWelcomesQuery,
  type WelcomeProofQuery,
} from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

const BASE64_PATTERN = '^[A-Za-z0-9+/]+={0,2}$';

// OpenAPI body — bounds mirror the enforced Zod (DeliverWelcomeSchema) so the documented contract
// matches what we accept. `welcome`/`ratchetTree` are opaque base64; the server never decrypts them.
class DeliverWelcomeBody {
  @ApiProperty({
    format: 'uuid',
    description: 'the user being added; must be a user in this tenant',
  })
  recipientUserId!: string;

  @ApiProperty({
    format: 'uuid',
    description: "the recipient's device whose claimed KeyPackage this Welcome is sealed to",
  })
  recipientDeviceId!: string;

  @ApiProperty({
    description: 'opaque base64 MLS Welcome — the server never decrypts it',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  welcome!: string;

  @ApiProperty({
    description: 'opaque base64 MLS RatchetTree — the server never decrypts it',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  ratchetTree!: string;
}

class DeliveredWelcomeDto {
  @ApiProperty({ format: 'uuid' })
  welcomeId!: string;
}

class PendingWelcomeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'the conversation to join with this welcome' })
  conversationId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'the verified member who added you (set server-side at deliver) — resolve a display name via the directory',
  })
  senderUserId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

class WelcomeMaterialDto {
  @ApiProperty({
    description: 'opaque base64 MLS Welcome — the server never decrypts it',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  welcome!: string;

  @ApiProperty({
    description: 'opaque base64 MLS RatchetTree — the server never decrypts it',
    maxLength: 32768,
    pattern: BASE64_PATTERN,
  })
  ratchetTree!: string;
}

// Relays opaque MLS Welcome material so an added member can join a group (the live message loop).
// Empty controller prefix: `deliver` is conversation-scoped (conversations/:id/welcomes) while
// `list`/`consume` are caller-scoped (welcomes, welcomes/:id), so paths are set per method.
@ApiTags('messaging')
@ApiBearerAuth()
@Controller()
export class WelcomesController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('conversations/:conversationId/welcomes')
  @ApiOperation({
    summary: 'Add a member and deliver their MLS Welcome (member-only)',
    operationId: 'deliverWelcome',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiBody({ type: DeliverWelcomeBody })
  @ApiCreatedResponse({ type: DeliveredWelcomeDto })
  @ApiBadRequestResponse({ description: 'invalid body, or recipient is not a user in this tenant' })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiForbiddenResponse({
    description: 'direct conversation requires an accepted friendship with the added recipient',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async deliver(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body(new ZodValidationPipe(DeliverWelcomeSchema)) body: DeliverWelcome,
  ): Promise<DeliveredWelcomeDto> {
    return this.messaging.deliverWelcome(auth, conversationId, body);
  }

  @Get('welcomes')
  @ApiOperation({
    summary:
      "Fetch the calling device's pending welcomes to join (caller + device scoped, bounded)",
    operationId: 'listWelcomes',
  })
  @ApiQuery({
    name: 'deviceId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: "the calling device's id — returns only welcomes sealed to its KeyPackage",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    description:
      'max welcomes to return (oldest first); drain the rest by consuming these + re-fetching',
  })
  @ApiOkResponse({ type: [PendingWelcomeDto] })
  @ApiBadRequestResponse({ description: 'missing or invalid deviceId / limit' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async list(
    @CurrentAuth() auth: VerifiedAuth,
    @Query(new ZodValidationPipe(ListWelcomesQuerySchema)) query: ListWelcomesQuery,
  ): Promise<PendingWelcomeDto[]> {
    return this.messaging.listMyWelcomes(auth, query.deviceId, query.limit);
  }

  @Get('welcomes/:welcomeId/material')
  @ApiOperation({
    summary: "Fetch one welcome's sealed join material (device proof-of-possession required)",
    operationId: 'getWelcomeMaterial',
  })
  @ApiParam({ name: 'welcomeId', format: 'uuid' })
  @ApiQuery({
    name: 'deviceId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: "the calling device's id — the welcome must be sealed to it",
  })
  @ApiQuery({
    name: 'proof',
    required: true,
    schema: { type: 'string', maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' },
    description: 'base64url Ed25519 FETCH proof-of-possession over (deviceId, welcomeId)',
  })
  @ApiOkResponse({ type: WelcomeMaterialDto })
  @ApiBadRequestResponse({ description: 'missing or invalid deviceId / proof' })
  @ApiNotFoundResponse({
    description: 'welcome not found, proof invalid, or not addressed to this caller + device',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async material(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('welcomeId', ParseUUIDPipe) welcomeId: string,
    @Query(new ZodValidationPipe(WelcomeProofQuerySchema)) query: WelcomeProofQuery,
  ): Promise<WelcomeMaterialDto> {
    return this.messaging.getWelcomeMaterial(auth, welcomeId, query.deviceId, query.proof);
  }

  @Delete('welcomes/:welcomeId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Consume (delete) a welcome after joining (recipient device only)',
    operationId: 'consumeWelcome',
  })
  @ApiParam({ name: 'welcomeId', format: 'uuid' })
  @ApiQuery({
    name: 'deviceId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: "the calling device's id — the welcome must be sealed to it",
  })
  @ApiQuery({
    name: 'proof',
    required: true,
    schema: { type: 'string', maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' },
    description: 'base64url Ed25519 CONSUME proof-of-possession over (deviceId, welcomeId)',
  })
  @ApiNoContentResponse({ description: 'welcome consumed' })
  @ApiBadRequestResponse({ description: 'missing or invalid deviceId / proof' })
  @ApiNotFoundResponse({
    description: 'welcome not found, proof invalid, or not addressed to this caller + device',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async consume(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('welcomeId', ParseUUIDPipe) welcomeId: string,
    @Query(new ZodValidationPipe(WelcomeProofQuerySchema)) query: WelcomeProofQuery,
  ): Promise<void> {
    await this.messaging.consumeWelcome(auth, welcomeId, query.deviceId, query.proof);
  }
}
