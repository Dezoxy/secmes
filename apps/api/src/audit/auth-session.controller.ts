import { Controller, Delete, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { UserService } from '../users/user.service.js';
import { AuditService } from './audit.service.js';

// Session lifecycle for stateless JWT auth: the SPA calls these after completing OIDC / on logout.
// Login JIT-provisions the user and writes the audit trail. Both require a valid token (global guard).
@ApiTags('auth')
@ApiBearerAuth()
@ApiHeader({ name: 'user-agent', required: false, description: 'optional client hint, audited' })
@Controller('auth/session')
export class AuthSessionController {
  constructor(
    private readonly audit: AuditService,
    private readonly users: UserService,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Start session: JIT-provision the user + record login',
    operationId: 'startSession',
  })
  @ApiNoContentResponse({ description: 'user provisioned and login recorded' })
  @ApiBadRequestResponse({ description: 'token missing the email claim required to provision' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async login(
    @CurrentAuth() auth: VerifiedAuth,
    @Ip() ip: string,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<void> {
    // Ensure the user row exists (idempotent) before auditing the login.
    await this.users.provisionFromToken(auth);
    await this.audit.record(auth.tenantId, {
      eventType: 'auth.login',
      actorSub: auth.sub,
      ip,
      userAgent: headers['user-agent'],
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
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<void> {
    await this.audit.record(auth.tenantId, {
      eventType: 'auth.logout',
      actorSub: auth.sub,
      ip,
      userAgent: headers['user-agent'],
    });
  }
}
