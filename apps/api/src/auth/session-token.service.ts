// Session-signing is server-auth infrastructure — see docs/threat-models/session-tokens.md §invariant-4.
import { randomBytes, createHash } from 'node:crypto';

import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';

import { schema, withRouting, withTenant } from '../db/index.js';
import { SESSION_SIGNING_KEY } from './session-key.config.js';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'argus_refresh';

export { COOKIE_NAME };

export interface MintedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class SessionTokenService {
  private readonly logger = new Logger(SessionTokenService.name);

  constructor(@Inject(SESSION_SIGNING_KEY) private readonly signingKey: CryptoKey) {}

  /**
   * Create a new session: insert an auth_sessions row, mint a 10-min access JWT and a 30-day refresh token.
   * Called by Phase 2 passkey verify after a successful ceremony.
   */
  async mintSession(opts: {
    tenantId: string;
    userId: string;
    sub: string;
  }): Promise<MintedSession> {
    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = sha256hex(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    const [session] = await withTenant(opts.tenantId, async (tx) => {
      // Ensure the argusid sub has a tenant binding so AuthService.verify() can derive tenantId
      // from the access token on all subsequent requests. user_tenant_index has no RLS; upsert is
      // safe here. Must run before the session INSERT so verify() never sees tenantId: null.
      await tx
        .insert(schema.userTenantIndex)
        .values({ sub: opts.sub, tenantId: opts.tenantId })
        .onConflictDoNothing();
      return tx
        .insert(schema.authSessions)
        .values({
          tenantId: opts.tenantId,
          userId: opts.userId,
          sub: opts.sub,
          refreshTokenHash,
          expiresAt,
        })
        .returning({ id: schema.authSessions.id });
    });
    if (!session) throw new Error('failed to create session row');

    const accessToken = await this.mintAccessToken(opts.sub, session.id, opts.userId);
    return { accessToken, refreshToken, sessionId: session.id };
  }

  /**
   * Rotate a refresh token (single-use). Implements reuse-detection: presenting a revoked token
   * is treated as theft and triggers full-family revocation.
   * See docs/threat-models/session-tokens.md §refresh-reuse-detection.
   */
  async rotateRefresh(refreshToken: string): Promise<MintedSession> {
    const tokenHash = sha256hex(refreshToken);
    const INVALID = 'invalid or expired session';

    // Pre-tenant lookup via GUC carve-out (mirrors acceptInvite). The carve-out exposes exactly
    // one row; tenant_id derived here is server-held data, not client input.
    const row = await withRouting(async (tx) => {
      await tx.execute(sql`select set_config('app.session_refresh_hash', ${tokenHash}, true)`);
      return tx
        .select({
          id: schema.authSessions.id,
          tenantId: schema.authSessions.tenantId,
          userId: schema.authSessions.userId,
          sub: schema.authSessions.sub,
          expiresAt: schema.authSessions.expiresAt,
          revokedAt: schema.authSessions.revokedAt,
        })
        .from(schema.authSessions)
        .where(eq(schema.authSessions.refreshTokenHash, tokenHash))
        .limit(1)
        .then((r) => r[0]);
    });

    if (!row) throw new UnauthorizedException(INVALID);

    if (row.revokedAt !== null) {
      // Reuse of a rotated/revoked token is a theft signal. Revoke the entire session family.
      this.logger.warn(
        `session.refresh_reuse: revoking all active sessions for user ${row.userId}`,
      );
      await withTenant(row.tenantId, (tx) =>
        tx
          .update(schema.authSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(schema.authSessions.userId, row.userId), isNull(schema.authSessions.revokedAt)),
          ),
      );
      throw new UnauthorizedException(INVALID);
    }

    if (row.expiresAt < new Date()) throw new UnauthorizedException(INVALID);

    // Mark-and-insert rotation: revoke the old token row and insert a new one in a single
    // transaction. The old row stays in the DB with revokedAt set, so presenting it later
    // triggers reuse detection (theft signal) even if the attacker rotated first.
    const newRefreshToken = randomBytes(32).toString('hex');
    const newHash = sha256hex(newRefreshToken);
    const now = new Date();

    const [newSession] = await withTenant(row.tenantId, async (tx) => {
      // Optimistic lock: WHERE refresh_token_hash = tokenHash guards against concurrent rotation.
      const revoked = await tx
        .update(schema.authSessions)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(
          and(
            eq(schema.authSessions.id, row.id),
            eq(schema.authSessions.refreshTokenHash, tokenHash),
            isNull(schema.authSessions.revokedAt),
          ),
        )
        .returning({ id: schema.authSessions.id });

      if (revoked.length === 0) {
        // Optimistic lock missed: the token was already rotated/revoked between the pre-tenant
        // SELECT and this UPDATE. Treat as a theft signal (same semantics as reuse detection) and
        // revoke the entire session family so the winner of the race also loses their session.
        this.logger.warn(
          `session.rotation_race: revoking all active sessions for user ${row.userId}`,
        );
        await tx
          .update(schema.authSessions)
          .set({ revokedAt: now })
          .where(
            and(eq(schema.authSessions.userId, row.userId), isNull(schema.authSessions.revokedAt)),
          );
        return [];
      }

      return tx
        .insert(schema.authSessions)
        .values({
          tenantId: row.tenantId,
          userId: row.userId,
          sub: row.sub,
          refreshTokenHash: newHash,
          expiresAt: row.expiresAt,
        })
        .returning({ id: schema.authSessions.id });
    });

    if (!newSession) throw new UnauthorizedException(INVALID);

    const accessToken = await this.mintAccessToken(row.sub, newSession.id, row.userId);
    return { accessToken, refreshToken: newRefreshToken, sessionId: newSession.id };
  }

  /** Revoke a specific session (logout). */
  async revokeSession(sessionId: string, tenantId: string): Promise<void> {
    await withTenant(tenantId, (tx) =>
      tx
        .update(schema.authSessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.authSessions.id, sessionId)),
    );
  }

  private async mintAccessToken(sub: string, sid: string, userId: string): Promise<string> {
    // uid: users.id (UUID) lets AuthService map argus tokens to the users table without relying on
    // external_identity_id, which carries Zitadel IDs and is incompatible with argusid:... subjects.
    // kid: 'argus-session-v1' enables future zero-downtime key rotation without token invalidation.
    return new SignJWT({ sub, sid, uid: userId })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'argus-session-v1' })
      .setIssuer('argus')
      .setAudience('argus-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(this.signingKey);
  }
}
