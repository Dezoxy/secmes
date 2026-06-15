import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTokenService } from './session-token.service.js';

// ---------------------------------------------------------------------------
// Unit tests (no DB) — mock withTenant / withRouting
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  withRouting: vi.fn(),
  withTenant: vi.fn(),
  schema: {
    authSessions: {
      id: 'id',
      tenantId: 'tenant_id',
      userId: 'user_id',
      sub: 'sub',
      refreshTokenHash: 'refresh_token_hash',
      expiresAt: 'expires_at',
      lastUsedAt: 'last_used_at',
      revokedAt: 'revoked_at',
    },
    userTenantIndex: {
      sub: 'sub',
      tenantId: 'tenant_id',
    },
  },
}));

import { withRouting, withTenant } from '../db/index.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const SUB = 'argusid:argus-k7m2q9x4f3n8p1w5-otter';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';

describe('SessionTokenService (unit)', () => {
  let svc: SessionTokenService;
  let signingKey: CryptoKey;
  let verifyKeys: JWTVerifyGetKey;

  beforeAll(async () => {
    const kp = await generateKeyPair('EdDSA', { extractable: true });
    signingKey = kp.privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), alg: 'EdDSA', kid: 'argus-session-v1' };
    verifyKeys = createLocalJWKSet({ keys: [jwk] });
  });

  beforeEach(() => {
    svc = new SessionTokenService(signingKey);
    vi.mocked(withTenant).mockReset();
    vi.mocked(withRouting).mockReset();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  // ------- mintSession -------------------------------------------------------

  describe('mintSession', () => {
    it('inserts a row and returns access+refresh tokens', async () => {
      vi.mocked(withTenant).mockResolvedValueOnce([{ id: SESSION_ID }]);

      const result = await svc.mintSession({ tenantId: TENANT, userId: USER_ID, sub: SUB });

      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
      expect(typeof result.accessToken).toBe('string');
    });

    it('access token is a valid EdDSA JWT with correct claims', async () => {
      vi.mocked(withTenant).mockResolvedValueOnce([{ id: SESSION_ID }]);

      const { accessToken } = await svc.mintSession({
        tenantId: TENANT,
        userId: USER_ID,
        sub: SUB,
      });

      const { payload } = await jwtVerify(accessToken, verifyKeys, {
        issuer: 'argus',
        audience: 'argus-api',
        algorithms: ['EdDSA'],
      });
      expect(payload.sub).toBe(SUB);
      expect(payload.sid).toBe(SESSION_ID);
      expect(payload['uid']).toBe(USER_ID); // uid allows user lookup by users.id without external_identity_id
      expect(payload['kid']).toBeUndefined(); // kid is in the header, not payload
    });

    it('access token header carries kid argus-session-v1', async () => {
      vi.mocked(withTenant).mockResolvedValueOnce([{ id: SESSION_ID }]);

      const { accessToken } = await svc.mintSession({
        tenantId: TENANT,
        userId: USER_ID,
        sub: SUB,
      });

      // Decode header without verification to check kid
      const [header] = accessToken.split('.');
      const decoded = JSON.parse(Buffer.from(header!, 'base64url').toString()) as {
        kid: string;
        alg: string;
      };
      expect(decoded.kid).toBe('argus-session-v1');
      expect(decoded.alg).toBe('EdDSA');
    });

    it('throws if the DB insert returns no rows', async () => {
      vi.mocked(withTenant).mockResolvedValueOnce([]);

      await expect(
        svc.mintSession({ tenantId: TENANT, userId: USER_ID, sub: SUB }),
      ).rejects.toThrow('failed to create session row');
    });
  });

  // ------- rotateRefresh ----------------------------------------------------

  function makeActiveRow(overrides?: Partial<{ revokedAt: Date | null; expiresAt: Date }>) {
    return {
      id: SESSION_ID,
      tenantId: TENANT,
      userId: USER_ID,
      sub: SUB,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      ...overrides,
    };
  }

  describe('rotateRefresh', () => {
    it('returns new access+refresh tokens and updates the row', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(makeActiveRow());
      vi.mocked(withTenant).mockResolvedValueOnce([{ id: SESSION_ID }]); // INSERT new session returning

      const { accessToken, refreshToken, sessionId } = await svc.rotateRefresh('a'.repeat(64));

      expect(sessionId).toBe(SESSION_ID);
      expect(refreshToken).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof accessToken).toBe('string');
    });

    it('access token has correct sub and sid after rotation', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(makeActiveRow());
      vi.mocked(withTenant).mockResolvedValueOnce([{ id: SESSION_ID }]); // INSERT new session returning

      const { accessToken } = await svc.rotateRefresh('b'.repeat(64));

      const { payload } = await jwtVerify(accessToken, verifyKeys, {
        issuer: 'argus',
        audience: 'argus-api',
        algorithms: ['EdDSA'],
      });
      expect(payload.sub).toBe(SUB);
      expect(payload.sid).toBe(SESSION_ID);
      expect(payload['uid']).toBe(USER_ID);
    });

    it('throws 401 when no matching session row found', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(undefined);

      await expect(svc.rotateRefresh('c'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws 401 when session is already revoked (revokedAt != null) and revokes the family', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(
        makeActiveRow({ revokedAt: new Date(Date.now() - 1000) }),
      );
      vi.mocked(withTenant).mockResolvedValueOnce(undefined); // family revocation UPDATE

      await expect(svc.rotateRefresh('d'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(withTenant).toHaveBeenCalledTimes(1); // family revocation fired
    });

    it('throws 401 when session is expired', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(
        makeActiveRow({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(svc.rotateRefresh('e'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(withTenant).not.toHaveBeenCalled(); // no rotation attempted
    });

    it('throws 401 and revokes session family when optimistic lock fails (concurrent rotation)', async () => {
      vi.mocked(withRouting).mockResolvedValueOnce(makeActiveRow());
      vi.mocked(withTenant).mockResolvedValueOnce([]); // lock failed → family revocation + [] returned

      await expect(svc.rotateRefresh('f'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(withTenant).toHaveBeenCalledTimes(1); // revocation runs inside the same withTenant call
    });
  });

  // ------- revokeSession ----------------------------------------------------

  describe('revokeSession', () => {
    it('calls withTenant to set revoked_at', async () => {
      vi.mocked(withTenant).mockResolvedValueOnce(undefined);

      await svc.revokeSession(SESSION_ID, TENANT);

      expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    });
  });
});

// ---------------------------------------------------------------------------
// DB-integration tests (requires real Postgres via DATABASE_URL)
// ---------------------------------------------------------------------------

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('SessionTokenService (DB integration)', () => {
  // These tests need a real schema. They are skipped in CI where DATABASE_URL is absent.
  // To run: docker run -d --name argus-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=argus \
  //   -p 55432:5432 public.ecr.aws/docker/library/postgres:16-alpine
  // export DATABASE_URL=postgres://postgres:postgres@localhost:55432/argus
  // pnpm --filter @argus/api db:migrate
  // pnpm --filter @argus/api test

  it('GUC unset → carve-out exposes zero rows (fail-closed)', async () => {
    const { withRouting: realWithRouting, schema: realSchema } = await import('../db/index.js');

    const rows = await realWithRouting(async (tx) => {
      // Do NOT set the GUC — carve-out must expose nothing.
      return tx.select({ id: realSchema.authSessions.id }).from(realSchema.authSessions).limit(5);
    });
    // Under withRouting with no tenant and no session_refresh_hash, FORCE RLS + the two policies
    // (both evaluate to NULL/FALSE) yield zero rows.
    expect(rows).toHaveLength(0);
  });
});
