import { Body, Controller, Delete, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { SsoConfig } from '@argus/contracts';
import { AdminGuard } from '../auth/admin.guard.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { perMinute, SENSITIVE_LIMITS } from '../rate-limit/rate-limit.constants.js';
import { SsoService } from './sso.service.js';

// ── Request DTOs ───────────────────────────────────────────────────────────────

class CreateSsoConfigBodyDto {
  @ApiProperty({ enum: ['oidc_generic', 'google', 'entra', 'okta'] })
  providerType!: string;
  @ApiProperty({ maxLength: 100 }) providerName!: string;
  @ApiProperty({ maxLength: 512 }) issuerUrl!: string;
  @ApiProperty({ maxLength: 256 }) clientId!: string;
  /** Never returned. Written to Zitadel, zeroed immediately after. */
  @ApiProperty({ maxLength: 1024, writeOnly: true }) clientSecret!: string;
}

class UpdateSsoConfigBodyDto {
  @ApiProperty({ maxLength: 100, required: false }) providerName?: string;
  @ApiProperty({ maxLength: 512, required: false }) issuerUrl?: string;
  @ApiProperty({ maxLength: 256, required: false }) clientId?: string;
}

class RotateSsoSecretBodyDto {
  /** New secret. Never stored in our DB; written to Zitadel only. */
  @ApiProperty({ maxLength: 1024, writeOnly: true }) clientSecret!: string;
}

// ── Response DTO ───────────────────────────────────────────────────────────────

class SsoConfigDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['oidc_generic', 'google', 'entra', 'okta'] }) providerType!: string;
  @ApiProperty({ maxLength: 100 }) providerName!: string;
  @ApiProperty({ maxLength: 512 }) issuerUrl!: string;
  @ApiProperty({ maxLength: 256 }) clientId!: string;
  @ApiProperty({ maxLength: 1024 }) loginUrl!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/sso-config')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  @Get()
  @ApiOperation({
    summary: 'Get tenant SSO config (admin only). Returns null body if not configured.',
    operationId: 'getSsoConfig',
  })
  @ApiOkResponse({
    description: 'SSO config, or null if not yet configured',
    schema: {
      nullable: true,
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        providerName: { type: 'string', maxLength: 100 },
        issuerUrl: { type: 'string', maxLength: 512 },
        clientId: { type: 'string', maxLength: 256 },
        loginUrl: { type: 'string', maxLength: 1024 },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
      required: [
        'id',
        'providerName',
        'issuerUrl',
        'clientId',
        'loginUrl',
        'createdAt',
        'updatedAt',
      ],
    },
  })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async getConfig(@CurrentAuth() auth: VerifiedAuth): Promise<SsoConfig | null> {
    return this.ssoService.getSsoConfig(auth);
  }

  @Post()
  @Throttle(perMinute(SENSITIVE_LIMITS.createSsoConfig))
  @ApiOperation({
    summary: 'Configure SSO for this tenant (admin only). Provisions a Zitadel org + IdP.',
    operationId: 'createSsoConfig',
  })
  @ApiCreatedResponse({ description: 'SSO configured', type: SsoConfigDto })
  @ApiConflictResponse({ description: 'SSO already configured' })
  @ApiServiceUnavailableResponse({
    description: 'Zitadel management not configured or unavailable',
  })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async createConfig(
    @CurrentAuth() auth: VerifiedAuth,
    @Body() body: CreateSsoConfigBodyDto,
  ): Promise<SsoConfig> {
    return this.ssoService.createSsoConfig(
      auth,
      body as unknown as import('@argus/contracts').CreateSsoConfigBody,
    );
  }

  @Patch()
  @Throttle(perMinute(SENSITIVE_LIMITS.updateSsoConfig))
  @ApiOperation({
    summary: 'Update tenant SSO config (admin only). Does not touch the client secret.',
    operationId: 'updateSsoConfig',
  })
  @ApiOkResponse({ description: 'SSO config updated', type: SsoConfigDto })
  @ApiNotFoundResponse({ description: 'SSO not configured' })
  @ApiServiceUnavailableResponse({
    description: 'Zitadel management not configured or unavailable',
  })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async updateConfig(
    @CurrentAuth() auth: VerifiedAuth,
    @Body() body: UpdateSsoConfigBodyDto,
  ): Promise<SsoConfig> {
    return this.ssoService.updateSsoConfig(
      auth,
      body as unknown as import('@argus/contracts').UpdateSsoConfigBody,
    );
  }

  @Patch('secret')
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.rotateSsoSecret))
  @ApiOperation({
    summary: 'Rotate the SSO client secret (admin only). New secret forwarded to Zitadel.',
    operationId: 'rotateSsoSecret',
  })
  @ApiNoContentResponse({ description: 'secret rotated' })
  @ApiNotFoundResponse({ description: 'SSO not configured' })
  @ApiServiceUnavailableResponse({
    description: 'Zitadel management not configured or unavailable',
  })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async rotateSecret(
    @CurrentAuth() auth: VerifiedAuth,
    @Body() body: RotateSsoSecretBodyDto,
  ): Promise<void> {
    return this.ssoService.rotateSsoSecret(
      auth,
      body as unknown as import('@argus/contracts').RotateSsoSecretBody,
    );
  }

  @Delete()
  @HttpCode(204)
  @Throttle(perMinute(SENSITIVE_LIMITS.deleteSsoConfig))
  @ApiOperation({
    summary: 'Remove tenant SSO config and delete Zitadel org (admin only).',
    operationId: 'deleteSsoConfig',
  })
  @ApiNoContentResponse({ description: 'SSO config deleted' })
  @ApiNotFoundResponse({ description: 'SSO not configured' })
  @ApiForbiddenResponse({ description: 'caller is not an admin' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async deleteConfig(@CurrentAuth() auth: VerifiedAuth): Promise<void> {
    return this.ssoService.deleteSsoConfig(auth);
  }
}
