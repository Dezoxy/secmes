import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import { PushService } from './push.service.js';
import { SubscribePushRequestSchema, type SubscribePushRequest } from './push.schemas.js';

// Bounds mirror SubscribePushRequestSchema (the enforced Zod) so the documented contract matches.
const BASE64URL_PATTERN = '^[A-Za-z0-9_-]+=*$';

class PushSubscriptionBody {
  @ApiProperty({
    description: 'base64url RFC 8291 receiver public key',
    maxLength: 256,
    pattern: BASE64URL_PATTERN,
  })
  p256dh!: string;

  @ApiProperty({
    description: 'base64url RFC 8291 auth secret',
    maxLength: 64,
    pattern: BASE64URL_PATTERN,
  })
  auth!: string;

  @ApiProperty({ description: 'push service endpoint URL (https only)', maxLength: 2048 })
  endpoint!: string;
}

class SubscribePushBody {
  @ApiProperty({
    description: 'the device registering this subscription',
    format: 'uuid',
    maxLength: 36,
  })
  deviceId!: string;

  @ApiProperty({ type: PushSubscriptionBody })
  subscription!: PushSubscriptionBody;
}

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Put('subscription')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.subscribePush))
  @ApiOperation({
    summary: "Register or update the caller's device push subscription",
    operationId: 'subscribePush',
  })
  @ApiBody({ type: SubscribePushBody })
  @ApiNoContentResponse({ description: 'subscription stored' })
  @ApiBadRequestResponse({
    description: 'invalid body, unsafe endpoint, or device not owned by caller',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async subscribe(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(SubscribePushRequestSchema)) body: SubscribePushRequest,
  ): Promise<void> {
    try {
      await this.push.upsert(auth, body);
    } catch (err) {
      if (err instanceof TypeError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Delete('subscription')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.subscribePush))
  @ApiOperation({
    summary: "Remove the caller's push subscription for a specific device",
    operationId: 'unsubscribePush',
  })
  @ApiQuery({
    name: 'deviceId',
    description: 'UUID of the device whose subscription to remove',
    required: true,
    schema: { type: 'string', format: 'uuid', maxLength: 36 },
  })
  @ApiNoContentResponse({ description: 'subscription removed (or was not present)' })
  @ApiBadRequestResponse({ description: 'deviceId is missing or not a valid UUID' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async unsubscribe(
    @CurrentAuth() auth: VerifiedAuth,
    @Query('deviceId', new ParseUUIDPipe()) deviceId: string,
  ): Promise<void> {
    await this.push.remove(auth, deviceId);
  }
}
