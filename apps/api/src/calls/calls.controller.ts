import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import {
  CreateCallRequestSchema,
  TurnCredentialsRequestSchema,
  UpdateCallSettingsRequestSchema,
  type CreateCallRequest,
  type TurnCredentialsRequest,
  type UpdateCallSettingsRequest,
} from './calls.schemas.js';
import { CallsService } from './calls.service.js';

// --- Response DTOs (Swagger schema classes, not exported — controller-local) ---

class IceServerDto {
  @ApiProperty({
    description: 'TURN/TURNS server URIs',
    type: [String],
    minItems: 1,
    maxItems: 8,
    example: ['turn:turn.4rgus.com:3478', 'turns:turn.4rgus.com:5349?transport=tcp'],
  })
  urls!: string[];

  @ApiProperty({
    description: 'Credential username: "<expiry-unix-ts>:<userId>"',
    minLength: 1,
    maxLength: 128,
  })
  username!: string;

  @ApiProperty({
    description:
      'base64 HMAC-SHA1 credential. SECRET-EQUIVALENT — do not log, store, or cache across calls.',
    minLength: 1,
    maxLength: 256,
  })
  credential!: string;
}

class TurnCredentialsResponseDto {
  @ApiProperty({ type: [IceServerDto], minItems: 1, maxItems: 8 })
  iceServers!: IceServerDto[];

  @ApiProperty({
    enum: ['relay', 'all'],
    description: '"relay" in V1 — forces TURN, peer IPs never disclosed',
    example: 'relay',
  })
  iceTransportPolicy!: 'relay' | 'all';

  @ApiProperty({
    description: 'Credential TTL in seconds. Client must re-fetch per call attempt.',
    minimum: 1,
    maximum: 3600,
    example: 600,
  })
  ttlSeconds!: number;
}

class CreateCallRequestDto {
  @ApiProperty({ description: '1:1 conversation to relay the call through', format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ enum: ['audio'], description: 'V1 audio-only; video lands in V1.1' })
  media!: 'audio';
}

class CreateCallResponseDto {
  @ApiProperty({
    description:
      'Server-minted call identifier. Always returned (uniform 202 — no friendship/presence oracle).',
    format: 'uuid',
  })
  callId!: string;
}

class CallSettingsResponseDto {
  @ApiProperty({ description: 'If true, force TURN relay (hide peer IP). Default: true.' })
  relayOnly!: boolean;
}

class UpdateCallSettingsRequestDto {
  @ApiProperty({ description: 'Set relay-only preference.' })
  relayOnly!: boolean;
}

// --- Controller ---

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /**
   * Mint ephemeral TURN credentials for WebRTC relay setup.
   *
   * Returns time-limited HMAC-SHA1 credentials for the coturn relay. The requester must have
   * ≥1 accepted friend (coarse abuse gate — docs/planning/voip/04 §2.2). Credentials are
   * relay-only (iceTransportPolicy=relay), hiding peer IPs in V1. TTL is 600–1200 s (windowed); clients must
   * re-fetch per call attempt and must NOT cache across calls.
   *
   * The `credential` field is SECRET-EQUIVALENT — it must never be logged or stored.
   */
  @Post('turn-credentials')
  @HttpCode(HttpStatus.OK)
  @Throttle(perMinute(SENSITIVE_LIMITS.turnCredentials))
  @ApiOperation({ summary: 'Mint ephemeral TURN relay credentials (relay-only, TTL 600–1200 s)' })
  @ApiBody({
    schema: { type: 'object', additionalProperties: false },
    required: false,
    description: 'Empty body — send {} or omit the body entirely',
  })
  @ApiOkResponse({ type: TurnCredentialsResponseDto, description: 'Ephemeral ICE server config' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiForbiddenResponse({ description: 'Requester has no accepted friends (coarse gate)' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded (30/min/user)' })
  mintTurnCredentials(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(TurnCredentialsRequestSchema.optional()))
    body: TurnCredentialsRequest | undefined,
  ) {
    void body;
    return this.calls.mintTurnCredentials(auth);
  }

  /**
   * Invite a friend to a 1:1 audio call.
   *
   * Always returns 202 + `{ callId }` — the caller cannot distinguish "not a friend", "not in this
   * conversation", or "call initiated" (no presence/friendship oracle). The callId is only
   * registered in the live authz map when both friendship and membership gates pass, so only a
   * genuine participant can reach the peer via `call.signal`.
   */
  @Post(':friendUserId/invite')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(perMinute(SENSITIVE_LIMITS.turnCredentials)) // reuse the same sensitive-endpoint budget
  @ApiOperation({
    summary: 'Invite a friend to a 1:1 audio call (uniform 202 — no presence oracle)',
  })
  @ApiBody({ type: CreateCallRequestDto })
  @ApiResponse({
    status: 202,
    type: CreateCallResponseDto,
    description: 'Call initiated (or gates failed — uniform response, no oracle)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  invite(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Body(new ZodValidationPipe(CreateCallRequestSchema)) body: CreateCallRequest,
  ) {
    return this.calls.invite(auth, friendUserId, body);
  }

  /** Return the authenticated user's relay-only call preference. */
  @Get('settings')
  @Throttle(perMinute(SENSITIVE_LIMITS.callSettings))
  @ApiOperation({ summary: 'Get call relay-only preference' })
  @ApiOkResponse({ type: CallSettingsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  getSettings(@CurrentAuth() auth: VerifiedAuth) {
    return this.calls.getSettings(auth);
  }

  /** Update the authenticated user's relay-only call preference. */
  @Put('settings')
  @Throttle(perMinute(SENSITIVE_LIMITS.callSettings))
  @ApiOperation({ summary: 'Update call relay-only preference' })
  @ApiBody({ type: UpdateCallSettingsRequestDto })
  @ApiOkResponse({ type: CallSettingsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  updateSettings(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(UpdateCallSettingsRequestSchema)) body: UpdateCallSettingsRequest,
  ) {
    return this.calls.updateSettings(auth, body);
  }
}
