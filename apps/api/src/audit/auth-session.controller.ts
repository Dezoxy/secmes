import { Controller, Delete, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { AuditService } from './audit.service.js';

// Session lifecycle for stateless JWT auth: the SPA calls these after completing OIDC / on logout,
// purely to write the login/logout audit trail. Both require a valid token (global guard).
@ApiTags('auth')
@ApiBearerAuth()
@ApiHeader({ name: 'user-agent', required: false, description: 'optional client hint, audited' })
@Controller('auth/session')
export class AuthSessionController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Record session start (login)', operationId: 'startSession' })
  @ApiNoContentResponse({ description: 'login recorded' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async login(
    @CurrentAuth() auth: VerifiedAuth,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.audit.record(auth.tenantId, {
      eventType: 'auth.login',
      actorSub: auth.sub,
      ip,
      userAgent,
    });
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Record session end (logout)', operationId: 'endSession' })
  @ApiNoContentResponse({ description: 'logout recorded' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async logout(
    @CurrentAuth() auth: VerifiedAuth,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.audit.record(auth.tenantId, {
      eventType: 'auth.logout',
      actorSub: auth.sub,
      ip,
      userAgent,
    });
  }
}
