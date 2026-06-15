import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { VerifiedAuth } from './auth.service.js';
import { AllowUnbound } from './allow-unbound.decorator.js';
import { CurrentAuth } from './current-auth.decorator.js';
import { Public } from './public.decorator.js';
import { COOKIE_NAME, SessionTokenService } from './session-token.service.js';

const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const REFRESH_COOKIE_PATH = '/auth/session/refresh';
const CSRF_HEADER = 'x-argus-refresh';

class RefreshResponseDto {
  @ApiProperty({ description: '10-minute EdDSA JWT; store in memory only, never in storage' })
  accessToken!: string;
}

@ApiTags('auth')
@Controller('auth/session')
export class SessionTokenController {
  private readonly logger = new Logger(SessionTokenController.name);

  constructor(private readonly sessions: SessionTokenService) {}

  /**
   * Rotate the refresh token: present the HttpOnly cookie, receive a new access token + rotated
   * cookie. Single-use: the old cookie is invalidated on success.
   *
   * CSRF protection: `SameSite=Strict` is the primary defence. The `X-Argus-Refresh: 1` custom
   * header is defense-in-depth (cross-origin requests cannot set custom headers without a CORS
   * preflight, which the API refuses for untrusted origins).
   *
   * Reuse detection: presenting an already-rotated refresh token revokes the entire session family
   * and returns 401 — treat this as a possible session theft signal.
   */
  @Post('refresh')
  @Public()
  @AllowUnbound()
  @ApiOperation({
    summary: 'Rotate refresh token — exchange HttpOnly cookie for a new access token',
    operationId: 'refreshSession',
    description:
      'Single-use refresh: the old cookie is revoked. ' +
      'Requires X-Argus-Refresh: 1 header (CSRF) and the argus_refresh HttpOnly cookie. ' +
      'Reuse of an already-rotated cookie triggers full session-family revocation.',
  })
  @ApiHeader({
    name: 'X-Argus-Refresh',
    description: 'Must be present (any non-empty value). CSRF defense-in-depth.',
    required: true,
  })
  @ApiOkResponse({ type: RefreshResponseDto, description: 'new access token' })
  @ApiUnauthorizedResponse({ description: 'missing/expired/revoked refresh token' })
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ): Promise<RefreshResponseDto> {
    if (!req.headers[CSRF_HEADER]) {
      throw new BadRequestException(`${CSRF_HEADER} header is required`);
    }

    const refreshToken = (req.cookies as Record<string, string | undefined>)[COOKIE_NAME];
    if (!refreshToken) {
      throw new BadRequestException('argus_refresh cookie is missing');
    }

    const { accessToken, refreshToken: newRefreshToken } =
      await this.sessions.rotateRefresh(refreshToken);

    res.cookie(COOKIE_NAME, newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_COOKIE_MAX_AGE * 1000, // express uses ms
    });

    this.logger.debug(`session refreshed from ${ip}`);
    return { accessToken };
  }

  /**
   * Revoke the caller's current session (logout). Requires a valid argus-minted bearer token
   * (the `sid` claim identifies which session to revoke). The refresh cookie is cleared.
   */
  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke the current argus session (logout)',
    operationId: 'logoutSession',
    description:
      'Revokes the auth_sessions row identified by the `sid` claim in the access token. ' +
      'The argus_refresh HttpOnly cookie is cleared.',
  })
  @ApiNoContentResponse({ description: 'session revoked' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentAuth() auth: VerifiedAuth,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (auth.sid) {
      await this.sessions.revokeSession(auth.sid, auth.tenantId);
    }

    // Clear the cookie regardless of whether the token carried a sid (Zitadel tokens don't).
    res.clearCookie(COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }
}
