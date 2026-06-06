import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DeliverWelcomeSchema, type DeliverWelcome } from './messaging.schemas.js';
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

  @ApiProperty({ description: 'opaque base64 MLS Welcome — the server never decrypts it' })
  welcome!: string;

  @ApiProperty({ description: 'opaque base64 MLS RatchetTree — the server never decrypts it' })
  ratchetTree!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
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
    summary: "Fetch the caller's pending welcomes to join (caller-scoped)",
    operationId: 'listWelcomes',
  })
  @ApiOkResponse({ type: [PendingWelcomeDto] })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async list(@CurrentAuth() auth: VerifiedAuth): Promise<PendingWelcomeDto[]> {
    return this.messaging.listMyWelcomes(auth);
  }

  @Delete('welcomes/:welcomeId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Consume (delete) a welcome after joining (recipient-only)',
    operationId: 'consumeWelcome',
  })
  @ApiParam({ name: 'welcomeId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'welcome consumed' })
  @ApiNotFoundResponse({ description: 'welcome not found or not addressed to the caller' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async consume(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('welcomeId', ParseUUIDPipe) welcomeId: string,
  ): Promise<void> {
    await this.messaging.consumeWelcome(auth, welcomeId);
  }
}
