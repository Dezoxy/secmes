import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from '../audit/audit.module.js';
import { DEFAULT_THROTTLE } from '../rate-limit/rate-limit.constants.js';
import { UserThrottlerGuard } from '../rate-limit/user-throttler.guard.js';
import { AuthService } from './auth.service.js';
import { BreakglassController } from './breakglass.controller.js';
import { BreakglassService } from './breakglass.service.js';
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
  controllers: [SessionTokenController, WebAuthnController, BreakglassController],
  providers: [
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
    BreakglassService,
    // Order matters: JwtAuthGuard runs FIRST (sets req.auth from the verified token), then the throttle
    // guard keys the limit on that verified user. Both are global (APP_GUARD).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
  exports: [AuthService, SessionTokenService, WebAuthnService, BreakglassService],
})
export class AuthModule {}
