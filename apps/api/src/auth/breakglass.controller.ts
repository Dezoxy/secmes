import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import {
  type BreakglassLoginRequest,
  BreakglassLoginRequestSchema,
  type BreakglassRotateRequest,
  BreakglassRotateRequestSchema,
} from '@argus/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PublicRateLimit } from '../rate-limit/public-rate-limit.decorator.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import { AdminGuard } from './admin.guard.js';
import { AllowUnbound } from './allow-unbound.decorator.js';
import { CurrentAuth } from './current-auth.decorator.js';
import type { VerifiedAuth } from './auth.service.js';
import { Public } from './public.decorator.js';
import { COOKIE_NAME } from './session-token.service.js';
import { BreakglassService } from './breakglass.service.js';

const REFRESH_COOKIE_PATH = (process.env['API_PATH_PREFIX'] ?? '/api') + '/auth/session/refresh';

class BreakglassLoginBodyDto {
  @ApiProperty({ description: 'Breakglass admin username' })
  username!: string;

  @ApiProperty({ description: 'Breakglass admin password' })
  password!: string;
}

class BreakglassRotateBodyDto {
  @ApiProperty({ description: 'Current breakglass password (re-auth gate)' })
  currentPassword!: string;

  @ApiProperty({ description: 'New breakglass password (min 12 characters)' })
  newPassword!: string;
}

class AccessTokenResponseDto {
  @ApiProperty({
    description: '10-minute EdDSA JWT; store in memory only, never in local/session storage',
  })
  accessToken!: string;
}

@ApiTags('auth')
@Controller('auth/breakglass')
export class BreakglassController {
  constructor(private readonly breakglass: BreakglassService) {}

  /**
   * Emergency admin login — validates the breakglass username + password (Argon2id), mints an
   * admin-role session, and sets an HttpOnly refresh cookie. Constant-time path: timing is
   * identical whether the username exists or not. Locks after 5 failures for 15 minutes.
   * See docs/threat-models/breakglass-admin.md.
   */
  @Post('login')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.breakglassLogin))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Breakglass admin login (emergency access)',
    operationId: 'breakglassLogin',
    description:
      'Validates username + Argon2id password. Constant-time regardless of username existence. ' +
      'Returns an admin-role access token and sets an HttpOnly refresh cookie. ' +
      'Locks for 15 minutes after 5 consecutive failures.',
  })
  @ApiBody({ type: BreakglassLoginBodyDto })
  @ApiOkResponse({ type: AccessTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'invalid credentials' })
  @ApiServiceUnavailableResponse({ description: 'breakglass not provisioned' })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(BreakglassLoginRequestSchema)) body: BreakglassLoginRequest,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<AccessTokenResponseDto> {
    const session = await this.breakglass.login(body.username, body.password, {
      ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    res.cookie(COOKIE_NAME, session.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()),
    });
    return { accessToken: session.accessToken };
  }

  /**
   * Rotate the breakglass password. Requires a valid admin bearer token AND the current password
   * (re-auth gate — a stolen session alone cannot silently replace the breakglass credential).
   * Wrong current password increments the shared login lockout counter.
   */
  @Post('rotate')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Rotate the breakglass admin password',
    operationId: 'breakglassRotate',
    description:
      'Requires an admin bearer token AND the current breakglass password. ' +
      'Wrong current password increments the same lockout counter as login.',
  })
  @ApiBody({ type: BreakglassRotateBodyDto })
  @ApiNoContentResponse({ description: 'password rotated' })
  @ApiUnauthorizedResponse({ description: 'invalid current password or locked' })
  @ApiForbiddenResponse({ description: 'caller does not hold a breakglass (Argus-minted) session' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async rotate(
    @Body(new ZodValidationPipe(BreakglassRotateRequestSchema)) body: BreakglassRotateRequest,
    @CurrentAuth() auth: VerifiedAuth,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<void> {
    // Zitadel/OIDC admin tokens may not carry an Argus userId — only a breakglass
    // session (minted by this service) holds the userId that matches admin_credentials.
    if (!auth.userId) {
      throw new ForbiddenException('rotate requires a breakglass session');
    }
    await this.breakglass.rotate(auth.userId, body.currentPassword, body.newPassword, {
      ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
    // Clear the refresh cookie — rotate() revokes all sessions, so this token is already
    // dead. Without clearing, the next refresh call would trigger reuse-detection and
    // revoke the new session the operator just minted after re-authenticating.
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}
