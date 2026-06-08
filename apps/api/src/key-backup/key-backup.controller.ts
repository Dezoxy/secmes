import { Body, Controller, Get, HttpCode, NotFoundException, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import { KeyBackupService } from './key-backup.service.js';
import { StoreBackupSchema, type StoreBackup } from './key-backup.schemas.js';

// Bounds mirror StoreBackupSchema (the enforced Zod) so the documented contract matches enforcement:
// the blob is opaque (never parsed server-side) but size-capped at 64 KiB to prevent abuse.
class BackupBody {
  @ApiProperty({
    description: 'opaque passphrase-sealed backup blob (the server never opens it)',
    minLength: 1,
    maxLength: 65536,
  })
  backup!: string;
}

@ApiTags('key-backup')
@ApiBearerAuth()
@Controller('backups/me')
export class KeyBackupController {
  constructor(private readonly backups: KeyBackupService) {}

  @Put()
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.storeBackup))
  @ApiOperation({ summary: "Store/replace the caller's sealed backup", operationId: 'storeBackup' })
  @ApiBody({ type: BackupBody })
  @ApiNoContentResponse({ description: 'backup stored' })
  @ApiBadRequestResponse({ description: 'invalid body, or user not provisioned' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async store(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(StoreBackupSchema)) body: StoreBackup,
  ): Promise<void> {
    await this.backups.store(auth, body.backup);
  }

  @Get()
  @Throttle(perMinute(SENSITIVE_LIMITS.fetchBackup))
  @ApiOperation({
    summary: "Fetch the caller's sealed backup for restore",
    operationId: 'getBackup',
  })
  @ApiOkResponse({ type: BackupBody, description: 'the opaque sealed backup blob' })
  @ApiNotFoundResponse({ description: 'no backup stored for this user' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async get(@CurrentAuth() auth: VerifiedAuth): Promise<BackupBody> {
    const backup = await this.backups.fetch(auth);
    if (backup === null) throw new NotFoundException('no backup stored');
    return { backup };
  }
}
