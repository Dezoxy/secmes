import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import {
  PublishKeyPackagesSchema,
  RevokeKeyPackagesSchema,
  type PublishKeyPackages,
  type RevokeKeyPackages,
} from './key-directory.schemas.js';

// Documents the request body in OpenAPI (the Zod type is erased at runtime). Zod still validates.
// Bounds mirror PublishKeyPackagesSchema (the enforced Zod) so the documented contract 42Crunch audits
// matches what the server actually accepts — base64 pattern, length caps, additionalProperties:false.
const BASE64_PATTERN = '^[A-Za-z0-9+/]+={0,2}$';

class PublishKeyPackagesBody {
  @ApiProperty({
    description: 'base64 MLS signature public key',
    maxLength: 512,
    pattern: BASE64_PATTERN,
  })
  signaturePublicKey!: string;

  @ApiProperty({
    type: [String],
    description: 'base64 one-time-use MLS KeyPackages (1–100)',
    minItems: 1,
    maxItems: 100,
    items: { type: 'string', maxLength: 8192, pattern: BASE64_PATTERN },
  })
  keyPackages!: string[];
}

class PublishResultDto {
  @ApiProperty()
  deviceId!: string;

  @ApiProperty({ description: 'net-new KeyPackages inserted by this call' })
  published!: number;

  @ApiProperty({ description: 'total unclaimed KeyPackages for this device after the call' })
  available!: number;
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

class RevokeKeyPackagesBody {
  @ApiProperty({
    description: "base64 MLS signature public key identifying the caller's own device",
    maxLength: 512,
    pattern: BASE64_PATTERN,
  })
  signaturePublicKey!: string;
}

class RevokeResultDto {
  @ApiProperty({ description: "unclaimed KeyPackages revoked (deleted) for the caller's device" })
  revoked!: number;
}

@ApiTags('key-directory')
@ApiBearerAuth()
@Controller()
export class KeyDirectoryController {
  constructor(private readonly dir: KeyDirectoryService) {}

  @Post('devices/me/key-packages')
  @HttpCode(200) // Nest defaults POST to 201; this returns 200 to match @ApiOkResponse
  @ApiOperation({
    summary: "Register the caller's device + publish one-time-use KeyPackages",
    operationId: 'publishKeyPackages',
  })
  @ApiBody({ type: PublishKeyPackagesBody })
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
  @HttpCode(200) // 200 (data returned), not Nest's default 201
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

  // POST (a mutation): deletes the caller's own device's unclaimed packages. Idempotent — revoking again
  // returns 0. Authz is the caller's verified identity + their device's signature key (own device only).
  @Post('devices/me/key-packages/revoke')
  @HttpCode(200) // 200 (data returned), not Nest's default 201
  @ApiOperation({
    summary: "Revoke the caller's own device's UNCLAIMED KeyPackages",
    operationId: 'revokeKeyPackages',
  })
  @ApiBody({ type: RevokeKeyPackagesBody })
  @ApiOkResponse({ type: RevokeResultDto })
  @ApiBadRequestResponse({ description: 'invalid body, or user not provisioned' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async revoke(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(RevokeKeyPackagesSchema)) body: RevokeKeyPackages,
  ): Promise<RevokeResultDto> {
    return this.dir.revokeUnclaimed(auth, body.signaturePublicKey);
  }
}
