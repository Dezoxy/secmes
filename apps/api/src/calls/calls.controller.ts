import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { TurnCredentialsRequestSchema, type TurnCredentialsRequest } from './calls.schemas.js';
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
}
