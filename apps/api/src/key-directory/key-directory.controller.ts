import { Body, Controller, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import { KeyDirectoryService } from './key-directory.service.js';
import { PublishKeyPackagesSchema, type PublishKeyPackages } from './key-directory.schemas.js';

class PublishResultDto {
  @ApiProperty()
  deviceId!: string;

  @ApiProperty()
  published!: number;
}

class ClaimedKeyPackageDto {
  @ApiProperty()
  deviceId!: string;

  @ApiProperty({
    description: 'base64 MLS signature public key — verify its fingerprint out-of-band',
  })
  signaturePublicKey!: string;

  @ApiProperty({ description: 'base64 one-time-use MLS KeyPackage' })
  keyPackage!: string;
}

@ApiTags('key-directory')
@ApiBearerAuth()
@Controller()
export class KeyDirectoryController {
  constructor(private readonly dir: KeyDirectoryService) {}

  @Post('devices/me/key-packages')
  @ApiOperation({
    summary: "Register the caller's device + publish one-time-use KeyPackages",
    operationId: 'publishKeyPackages',
  })
  @ApiOkResponse({ type: PublishResultDto })
  @ApiBadRequestResponse({ description: 'invalid body, or user not provisioned' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async publish(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(PublishKeyPackagesSchema)) body: PublishKeyPackages,
  ): Promise<PublishResultDto> {
    return this.dir.publish(auth, body.signaturePublicKey, body.keyPackages);
  }

  // POST, not GET: claiming consumes a one-time-use package (a mutation) — must not be cacheable/prefetchable.
  @Post('users/:userId/key-package/claim')
  @ApiOperation({
    summary: 'Claim a fresh one-time-use KeyPackage for a user',
    operationId: 'claimKeyPackage',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: ClaimedKeyPackageDto })
  @ApiNotFoundResponse({ description: 'no key package available — ask the user to replenish' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async claim(
    @CurrentAuth() auth: VerifiedAuth,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<ClaimedKeyPackageDto> {
    const claimed = await this.dir.claim(auth, userId);
    if (!claimed) throw new NotFoundException('no key package available for this user');
    return claimed;
  }
}
