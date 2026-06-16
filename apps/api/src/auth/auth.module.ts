import { Logger, Module, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

import { AuditModule } from '../audit/audit.module.js';
import { DEFAULT_THROTTLE } from '../rate-limit/rate-limit.constants.js';
import { UserThrottlerGuard } from '../rate-limit/user-throttler.guard.js';
import { OIDC_CONFIG, OIDC_JWKS, loadOidcConfig, type OidcConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import {
  SESSION_KEY_PAIR,
  SESSION_SIGNING_KEY,
  SESSION_VERIFY_KEY,
  loadSessionKeys,
  type SessionKeyPair,
} from './session-key.config.js';
import { SessionTokenController } from './session-token.controller.js';
import { SessionTokenService } from './session-token.service.js';
import { WebAuthnController } from './webauthn.controller.js';
import { WebAuthnService } from './webauthn.service.js';

@Module({
  imports: [ThrottlerModule.forRoot(DEFAULT_THROTTLE), AuditModule],
  controllers: [SessionTokenController, WebAuthnController],
  providers: [
    { provide: OIDC_CONFIG, useFactory: loadOidcConfig },
    {
      provide: OIDC_JWKS,
      inject: [OIDC_CONFIG],
      useFactory: (cfg: OidcConfig): JWTVerifyGetKey => {
        if (!cfg.configured) {
          // Diagnose a partial misconfig (some-but-not-all vars set) — names only, none are secret.
          // Behaviour is unchanged (still fails closed); this just distinguishes it from "not wired yet".
          const missing = (
            [
              ['OIDC_ISSUER', cfg.issuer],
              ['OIDC_AUDIENCE', cfg.audience],
              ['OIDC_JWKS_URI', cfg.jwksUri],
            ] as const
          )
            .filter(([, v]) => !v)
            .map(([k]) => k);
          if (missing.length > 0 && missing.length < 3) {
            new Logger('AuthModule').warn(
              `OIDC partially configured — protected routes fail closed. Missing: ${missing.join(', ')}`,
            );
          }
          // Boot-safe until Zitadel is wired (checkpoint 9): no JWKS yet, so every protected
          // route fails closed with 401 instead of crashing the app at startup.
          return async () => {
            throw new UnauthorizedException('OIDC not configured');
          };
        }
        // Lazy: jose fetches + caches the JWKS on first verify, refetches on unknown kid (rotation).
        return createRemoteJWKSet(new URL(cfg.jwksUri));
      },
    },
    // Phase 1 — self-minted session keys. Loaded once (SESSION_KEY_PAIR); both derived from the same
    // pair to avoid generating mismatched ephemeral keys in dev.
    // See docs/threat-models/session-tokens.md §invariant-4 for the exception boundary.
    { provide: SESSION_KEY_PAIR, useFactory: loadSessionKeys },
    {
      provide: SESSION_SIGNING_KEY,
      inject: [SESSION_KEY_PAIR],
      useFactory: (kp: SessionKeyPair): CryptoKey => kp.privateKey,
    },
    {
      provide: SESSION_VERIFY_KEY,
      inject: [SESSION_KEY_PAIR],
      useFactory: (kp: SessionKeyPair): CryptoKey => kp.publicKey,
    },
    AuthService,
    SessionTokenService,
    WebAuthnService,
    // Order matters: JwtAuthGuard runs FIRST (sets req.auth from the verified token), then the throttle
    // guard keys the limit on that verified user. Both are global (APP_GUARD).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
  exports: [AuthService, SessionTokenService, WebAuthnService],
})
export class AuthModule {}
