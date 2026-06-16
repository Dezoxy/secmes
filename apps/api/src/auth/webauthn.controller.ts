import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Response } from 'express';

import {
  type AuthenticateVerifyRequest,
  AuthenticateVerifyRequestSchema,
  type RedeemCodeRequest,
  RedeemCodeRequestSchema,
  type RegisterOptionsRequest,
  RegisterOptionsRequestSchema,
  type RegisterVerifyRequest,
  RegisterVerifyRequestSchema,
} from '@argus/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PublicRateLimit } from '../rate-limit/public-rate-limit.decorator.js';
import { SENSITIVE_LIMITS, perMinute } from '../rate-limit/rate-limit.constants.js';
import { AllowUnbound } from './allow-unbound.decorator.js';
import { Public } from './public.decorator.js';
import { COOKIE_NAME } from './session-token.service.js';
import { WebAuthnService } from './webauthn.service.js';

const REFRESH_COOKIE_PATH = (process.env['API_PATH_PREFIX'] ?? '/api') + '/auth/session/refresh';

// ---- DTOs ----------------------------------------------------------------

class RedeemCodeBodyDto {
  @ApiProperty({ description: 'Admin-issued invite code (256-bit hex string)' })
  code!: string;
}

class CeremonyResponseDto {
  @ApiProperty({ description: 'Opaque ceremony ID; pass to the next step in the ceremony' })
  ceremonyId!: string;
}

class RegisterOptionsBodyDto {
  @ApiProperty({ description: 'Ceremony ID returned by /auth/register/redeem' })
  ceremonyId!: string;
}

class RegisterVerifyBodyDto {
  @ApiProperty()
  ceremonyId!: string;

  @ApiProperty({
    type: 'object',
    required: ['id', 'rawId', 'response', 'type'],
    properties: {
      id: { type: 'string' },
      rawId: { type: 'string' },
      response: {
        type: 'object',
        required: ['clientDataJSON', 'attestationObject'],
        properties: {
          clientDataJSON: { type: 'string' },
          attestationObject: { type: 'string' },
          authenticatorData: { type: 'string' },
          transports: { type: 'array', items: { type: 'string' } },
        },
      },
      authenticatorAttachment: { type: 'string' },
      clientExtensionResults: {
        type: 'object',
        properties: {
          credProps: { type: 'object', properties: { rk: { type: 'boolean' } } },
          prf: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              results: {
                type: 'object',
                properties: {
                  first: { type: 'string' },
                  second: { type: 'string' },
                },
              },
            },
          },
        },
      },
      type: { type: 'string', enum: ['public-key'] },
    },
    description: 'PublicKeyCredential JSON from navigator.credentials.create()',
  })
  registrationResponse!: RegistrationResponseJSON;
}

class AuthenticateVerifyBodyDto {
  @ApiProperty()
  ceremonyId!: string;

  @ApiProperty({
    type: 'object',
    required: ['id', 'rawId', 'response', 'type'],
    properties: {
      id: { type: 'string' },
      rawId: { type: 'string' },
      response: {
        type: 'object',
        required: ['clientDataJSON', 'authenticatorData', 'signature'],
        properties: {
          clientDataJSON: { type: 'string' },
          authenticatorData: { type: 'string' },
          signature: { type: 'string' },
          userHandle: { type: 'string' },
        },
      },
      authenticatorAttachment: { type: 'string' },
      clientExtensionResults: {
        type: 'object',
        properties: {
          prf: {
            type: 'object',
            properties: {
              results: {
                type: 'object',
                properties: {
                  first: { type: 'string' },
                  second: { type: 'string' },
                },
              },
            },
          },
        },
      },
      type: { type: 'string', enum: ['public-key'] },
    },
    description: 'PublicKeyCredential JSON from navigator.credentials.get()',
  })
  authenticationResponse!: AuthenticationResponseJSON;
}

class AuthenticateOptionsResponseDto {
  @ApiProperty()
  ceremonyId!: string;

  @ApiProperty({
    type: 'object',
    required: ['challenge'],
    properties: {
      challenge: { type: 'string' },
      timeout: { type: 'integer' },
      rpId: { type: 'string' },
      allowCredentials: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          required: ['id', 'type'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['public-key'] },
            transports: { type: 'array', maxItems: 10, items: { type: 'string' } },
          },
        },
      },
      userVerification: { type: 'string', enum: ['required', 'preferred', 'discouraged'] },
      extensions: {
        type: 'object',
        properties: { prf: { type: 'object', properties: {} } },
      },
      hints: { type: 'array', maxItems: 10, items: { type: 'string' } },
    },
    description: 'PublicKeyCredentialRequestOptions for navigator.credentials.get()',
  })
  options!: object;
}

class AccessTokenResponseDto {
  @ApiProperty({
    description: '10-minute EdDSA JWT; store in memory only, never in local/session storage',
  })
  accessToken!: string;
}

// ---- Controller ----------------------------------------------------------

@ApiTags('auth')
@Controller('auth')
export class WebAuthnController {
  private readonly logger = new Logger(WebAuthnController.name);

  constructor(private readonly webauthn: WebAuthnService) {}

  /**
   * Step 1 of passkey registration: validate the admin-issued invite code and open a
   * registration ceremony. The ceremony expires in 5 minutes.
   */
  @Post('register/redeem')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.passkeyRedeem))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Redeem an invite code and open a passkey registration ceremony',
    operationId: 'redeemInviteCode',
    description:
      'Validates the admin-issued invite code (single-use, 5-min expiry). ' +
      'Returns a ceremonyId that must be passed to /auth/webauthn/register/options.',
  })
  @ApiBody({ type: RedeemCodeBodyDto })
  @ApiOkResponse({ type: CeremonyResponseDto })
  @ApiUnauthorizedResponse({ description: 'invalid or expired invite code' })
  @HttpCode(HttpStatus.OK)
  redeemCode(
    @Body(new ZodValidationPipe(RedeemCodeRequestSchema)) body: RedeemCodeRequest,
  ): Promise<CeremonyResponseDto> {
    return this.webauthn.redeemCode(body.code);
  }

  /**
   * Step 2 of passkey registration: get WebAuthn registration options for the ceremony.
   * Returns the PublicKeyCredentialCreationOptions to pass to navigator.credentials.create().
   */
  @Post('webauthn/register/options')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.passkeyAuthenticate))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Get WebAuthn registration options',
    operationId: 'getRegistrationOptions',
    description:
      'Returns PublicKeyCredentialCreationOptions. Pass the result to navigator.credentials.create().',
  })
  @ApiBody({ type: RegisterOptionsBodyDto })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['challenge', 'rp', 'user', 'pubKeyCredParams'],
      properties: {
        challenge: { type: 'string' },
        rp: {
          type: 'object',
          required: ['name'],
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
        user: {
          type: 'object',
          required: ['id', 'name', 'displayName'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            displayName: { type: 'string' },
          },
        },
        pubKeyCredParams: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['alg', 'type'],
            properties: {
              alg: { type: 'integer' },
              type: { type: 'string', enum: ['public-key'] },
            },
          },
        },
        timeout: { type: 'integer' },
        excludeCredentials: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            required: ['id', 'type'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['public-key'] },
              transports: { type: 'array', maxItems: 10, items: { type: 'string' } },
            },
          },
        },
        authenticatorSelection: {
          type: 'object',
          properties: {
            residentKey: { type: 'string' },
            userVerification: { type: 'string' },
            requireResidentKey: { type: 'boolean' },
            authenticatorAttachment: { type: 'string' },
          },
        },
        attestation: { type: 'string' },
        extensions: {
          type: 'object',
          properties: { prf: { type: 'object', properties: {} } },
        },
      },
    },
    description: 'PublicKeyCredentialCreationOptions JSON',
  })
  @ApiUnauthorizedResponse({ description: 'ceremony not found or expired' })
  @HttpCode(HttpStatus.OK)
  getRegistrationOptions(
    @Body(new ZodValidationPipe(RegisterOptionsRequestSchema)) body: RegisterOptionsRequest,
  ): Promise<object> {
    return this.webauthn.getRegistrationOptions(body.ceremonyId);
  }

  /**
   * Step 3 of passkey registration: verify the attestation, create the user account, and
   * mint the first session. Sets an HttpOnly refresh cookie on success.
   */
  @Post('webauthn/register/verify')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.passkeyAuthenticate))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Verify passkey registration and create account',
    operationId: 'verifyRegistration',
    description:
      'Atomically: delete the ceremony, consume the invite, create the user, register the passkey, mint a session. ' +
      'Returns an access token and sets an HttpOnly refresh cookie.',
  })
  @ApiBody({ type: RegisterVerifyBodyDto })
  @ApiCreatedResponse({ type: AccessTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'attestation verification failed or ceremony not found' })
  @HttpCode(HttpStatus.CREATED)
  async verifyRegistration(
    @Body(new ZodValidationPipe(RegisterVerifyRequestSchema)) body: RegisterVerifyRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenResponseDto> {
    const session = await this.webauthn.verifyRegistration(
      body.ceremonyId,
      body.registrationResponse as unknown as RegistrationResponseJSON,
    );
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
   * Step 1 of passkey authentication: get discoverable-credential options.
   * allowCredentials is empty — no enumeration oracle.
   */
  @Post('webauthn/authenticate/options')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.passkeyAuthenticate))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Get WebAuthn authentication options (discoverable credentials)',
    operationId: 'getAuthenticationOptions',
    description:
      'Returns an empty allowCredentials list — discoverable flow, no username/argus-id required. ' +
      'Pass options to navigator.credentials.get().',
  })
  @ApiOkResponse({ type: AuthenticateOptionsResponseDto })
  @HttpCode(HttpStatus.OK)
  getAuthenticationOptions(): Promise<AuthenticateOptionsResponseDto> {
    return this.webauthn.getAuthenticationOptions();
  }

  /**
   * Step 2 of passkey authentication: verify the assertion and mint a session.
   * Sets an HttpOnly refresh cookie on success.
   */
  @Post('webauthn/authenticate/verify')
  @Public()
  @PublicRateLimit()
  @Throttle(perMinute(SENSITIVE_LIMITS.passkeyAuthenticate))
  @AllowUnbound()
  @ApiOperation({
    summary: 'Verify passkey assertion and mint session',
    operationId: 'verifyAuthentication',
    description:
      'Verifies the WebAuthn assertion. Identity is resolved from the stored credential row only — ' +
      'the client-posted userHandle is cross-checked but never trusted as the authority. ' +
      'Counter regression (possible clone) returns 401.',
  })
  @ApiBody({ type: AuthenticateVerifyBodyDto })
  @ApiOkResponse({ type: AccessTokenResponseDto })
  @ApiUnauthorizedResponse({
    description: 'assertion failed, userHandle mismatch, or counter regression',
  })
  @HttpCode(HttpStatus.OK)
  async verifyAuthentication(
    @Body(new ZodValidationPipe(AuthenticateVerifyRequestSchema)) body: AuthenticateVerifyRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenResponseDto> {
    const session = await this.webauthn.verifyAuthentication(
      body.ceremonyId,
      body.authenticationResponse as unknown as AuthenticationResponseJSON,
    );
    res.cookie(COOKIE_NAME, session.refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()),
    });
    return { accessToken: session.accessToken };
  }
}
