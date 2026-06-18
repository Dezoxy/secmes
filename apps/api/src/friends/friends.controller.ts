import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
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
import { Throttle } from '@nestjs/throttler';
import {
  FriendRequestBoxSchema,
  SendFriendRequestSchema,
  type FriendRequestBox,
  type SendFriendRequest,
} from '@argus/contracts';

import { AuditService } from '../audit/audit.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { perHour, perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { FriendsService } from './friends.service.js';

// Only log a target argus-id verbatim when it is well-formed; a free-text probe could carry secrets or
// a presigned URL. Mirrors the sanitisation in users.controller.ts (the lookup audit path).
const ARGUS_ID_RE = /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/;

class SendFriendRequestBodyDto {
  @ApiProperty({ description: 'Exact argus-id of the user to befriend', maxLength: 128 })
  argusId!: string;
}

class SendFriendRequestResponseDto {
  @ApiProperty({
    enum: ['accepted'],
    description: 'Constant — carries no outcome (no enumeration oracle)',
  })
  status!: 'accepted';
}

class FriendDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  argusId!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarSeed!: string | null;

  @ApiProperty({ format: 'date-time' })
  since!: string;
}

class FriendListResponseDto {
  @ApiProperty({ type: [FriendDto] })
  friends!: FriendDto[];
}

class FriendRequestDto {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  argusId!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarSeed!: string | null;

  @ApiProperty({ enum: ['incoming', 'outgoing'] })
  direction!: FriendRequestBox;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

class FriendRequestListResponseDto {
  @ApiProperty({ type: [FriendRequestDto] })
  requests!: FriendRequestDto[];
}

@ApiTags('friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendsController {
  constructor(
    private readonly friends: FriendsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Send a friend request by exact argus-id. ALWAYS returns 202 — found, not-found, inactive, self,
   * already-friends, and already-pending are indistinguishable to the caller (no enumeration oracle;
   * R-friends-3). The recipient's inbox is the only place a real request surfaces.
   */
  @Post('requests')
  @Throttle(perHour(SENSITIVE_LIMITS.sendFriendRequest))
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a friend request by argus-id', operationId: 'sendFriendRequest' })
  @ApiBody({ type: SendFriendRequestBodyDto })
  @ApiAcceptedResponse({
    type: SendFriendRequestResponseDto,
    description: 'request accepted for processing (uniform — no outcome leaked)',
  })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async sendRequest(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(SendFriendRequestSchema)) body: SendFriendRequest,
  ): Promise<SendFriendRequestResponseDto> {
    const { targetFound } = await this.friends.sendRequest(auth, body.argusId);
    const safeArgusId = ARGUS_ID_RE.test(body.argusId) ? body.argusId : '<invalid-format>';
    await this.audit.record(auth.tenantId, {
      eventType: 'friends.request_created',
      actorSub: auth.sub,
      metadata: { targetArgusId: safeArgusId, found: targetFound },
    });
    // Constant body for EVERY outcome — preserves the uniform-202 non-oracle property.
    return { status: 'accepted' };
  }

  /** List accepted friends — the durable contact source after a reinstall. */
  @Get()
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsList))
  @ApiOperation({ summary: 'List accepted friends', operationId: 'listFriends' })
  @ApiOkResponse({ type: FriendListResponseDto })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listFriends(@CurrentAuth() auth: VerifiedAuth): Promise<FriendListResponseDto> {
    const friends = await this.friends.listFriends(auth);
    return { friends };
  }

  /** List open friend requests in one mailbox (incoming = sent to me, outgoing = sent by me). */
  @Get('requests')
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsList))
  @ApiOperation({ summary: 'List open friend requests', operationId: 'listFriendRequests' })
  @ApiQuery({ name: 'box', required: true, enum: ['incoming', 'outgoing'] })
  @ApiOkResponse({ type: FriendRequestListResponseDto })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async listRequests(
    @CurrentAuth() auth: VerifiedAuth,
    @Query('box', new ZodValidationPipe(FriendRequestBoxSchema)) box: FriendRequestBox,
  ): Promise<FriendRequestListResponseDto> {
    const requests = await this.friends.listRequests(auth, box);
    return { requests };
  }

  /** Accept a pending request — recipient-only. 404 if not addressed to the caller (no IDOR). */
  @Post('requests/:id/accept')
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsAction))
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Accept a friend request', operationId: 'acceptFriendRequest' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'request accepted' })
  @ApiNotFoundResponse({ description: 'no pending request with that id addressed to the caller' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async accept(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) requestId: string,
  ): Promise<void> {
    await this.friends.accept(auth, requestId);
  }

  /** Decline a pending request — recipient-only; hard delete (no rejection ledger). */
  @Post('requests/:id/decline')
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsAction))
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline a friend request', operationId: 'declineFriendRequest' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'request declined and deleted' })
  @ApiNotFoundResponse({ description: 'no pending request with that id addressed to the caller' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async decline(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) requestId: string,
  ): Promise<void> {
    await this.friends.decline(auth, requestId);
  }

  /** Cancel a pending request the caller sent — requester-only; hard delete. */
  @Delete('requests/:id')
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsAction))
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a sent friend request', operationId: 'cancelFriendRequest' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'request cancelled and deleted' })
  @ApiNotFoundResponse({ description: 'no pending request with that id sent by the caller' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async cancel(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('id', ParseUUIDPipe) requestId: string,
  ): Promise<void> {
    await this.friends.cancel(auth, requestId);
  }

  /** Unfriend an accepted friend — member-only; hard delete. Addressed by the friend's userId. */
  @Delete(':userId')
  @Throttle(perMinute(SENSITIVE_LIMITS.friendsAction))
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an accepted friend', operationId: 'unfriend' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'friendship removed' })
  @ApiNotFoundResponse({ description: 'no accepted friendship with that user' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async unfriend(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('userId', ParseUUIDPipe) friendUserId: string,
  ): Promise<void> {
    await this.friends.unfriend(auth, friendUserId);
  }
}
