import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import { RecordReceiptSchema, type RecordReceipt } from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

class RecordReceiptBody {
  @ApiProperty({ enum: ['delivered', 'read'] })
  status!: 'delivered' | 'read';

  @ApiProperty({
    format: 'uuid',
    description: 'the message received/read THROUGH (earlier implied)',
  })
  throughMessageId!: string;
}

class ConversationReceiptDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'the member this receipt is for' })
  userId!: string;

  @ApiProperty({ type: String, required: false, nullable: true, format: 'uuid' })
  deliveredThroughMessageId!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, format: 'date-time' })
  deliveredAt!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, format: 'uuid' })
  readThroughMessageId!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true, format: 'date-time' })
  readAt!: string | null;
}

@ApiTags('messaging')
@ApiBearerAuth()
@Controller('conversations')
export class ReceiptsController {
  constructor(private readonly messaging: MessagingService) {}

  @Post(':conversationId/receipts')
  @HttpCode(204)
  @ApiOperation({
    summary: "Advance the caller's delivered/read watermark in a conversation",
    operationId: 'recordReceipt',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiBody({ type: RecordReceiptBody })
  @ApiNoContentResponse({ description: 'watermark recorded (or already past)' })
  @ApiBadRequestResponse({ description: 'invalid body, or user not provisioned' })
  @ApiNotFoundResponse({ description: 'conversation/message not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async record(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body(new ZodValidationPipe(RecordReceiptSchema)) body: RecordReceipt,
  ): Promise<void> {
    await this.messaging.recordReceipt(auth, conversationId, body);
  }

  @Get(':conversationId/receipts')
  @ApiOperation({
    summary: 'Per-member delivered/read watermarks for a conversation',
    operationId: 'getReceipts',
  })
  @ApiParam({ name: 'conversationId', format: 'uuid' })
  @ApiOkResponse({ type: [ConversationReceiptDto] })
  @ApiNotFoundResponse({ description: 'conversation not found or caller is not a member' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async get(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<ConversationReceiptDto[]> {
    return this.messaging.getReceipts(auth, conversationId);
  }
}
