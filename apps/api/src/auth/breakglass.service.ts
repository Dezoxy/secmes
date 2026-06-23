// Breakglass admin authentication — server-auth infrastructure.
// See docs/threat-models/breakglass-admin.md for the full security analysis.
// @noble/hashes Argon2id is a pre-cleared exception to invariant #4 (same as jose for sessions);
// permitted exclusively inside apps/api/src/auth/. See breakglass-admin.md §invariant-4.
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { schema, withTenant } from '../db/index.js';
import { generateArgusId, isArgusIdCollision } from '../users/argus-id.js';
import { AuditService } from '../audit/audit.service.js';
import { type MintedSession, SessionTokenService } from './session-token.service.js';
import { authAttempts } from '../observability/metrics.js';

// Fixed single-tenant UUID — matches DEFAULT_TENANT_ID in webauthn.service.ts. Must be a valid
// RFC-4122 UUID (version + variant nibbles) so it passes the contracts' strict z.string().uuid().
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15-minute flat window
const PARAMS = { m: 65536, t: 3, p: 1 }; // 64 MiB · 3 passes · 1 lane (same floor as the keystore)
const HASH_LEN = 32;
const SALT_LEN = 16;
const MIN_PARAMS = { m: 8192, t: 2, p: 1 }; // absolute floor — prevents a weak Key Vault value
// Upper ceiling: 1 GiB / 200 iters / 16 threads — prevents a malformed Key Vault value from
// causing an OOM or runaway CPU burn on the login path.
const MAX_PARAMS = { m: 1048576, t: 200, p: 16 };

interface KdfParams {
  m: number;
  t: number;
  p: number;
}

interface BootstrapHash extends KdfParams {
  hash: string; // base64
  salt: string; // base64
}

function assertParams(p: KdfParams): void {
  if (!Number.isInteger(p.m) || !Number.isInteger(p.t) || !Number.isInteger(p.p)) {
    throw new Error('kdf_params must be integers');
  }
  if (p.m < MIN_PARAMS.m || p.t < MIN_PARAMS.t || p.p < MIN_PARAMS.p) {
    throw new Error('kdf_params below minimum security floor');
  }
  if (p.m > MAX_PARAMS.m || p.t > MAX_PARAMS.t || p.p > MAX_PARAMS.p) {
    throw new Error('kdf_params above maximum ceiling');
  }
}

function resolveBootstrapFile(): string {
  const path = process.env['ADMIN_BOOTSTRAP_HASH_FILE'];
  if (!path) return '';
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function parseBootstrapFile(content: string): BootstrapHash {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  const p = parsed as Record<string, unknown>;
  if (
    typeof p['hash'] !== 'string' ||
    typeof p['salt'] !== 'string' ||
    typeof p['m'] !== 'number' ||
    typeof p['t'] !== 'number' ||
    typeof p['p'] !== 'number'
  ) {
    throw new Error('missing required fields (hash, salt, m, t, p)');
  }
  const params: KdfParams = { m: p['m'], t: p['t'], p: p['p'] };
  assertParams(params);
  // Validate decoded byte lengths to catch base64 truncation / wrong encoding
  // before the value reaches the login path (where a wrong length would cause
  // timingSafeEqual to throw rather than returning false).
  const hashBytes = Buffer.from(p['hash'], 'base64');
  const saltBytes = Buffer.from(p['salt'], 'base64');
  if (hashBytes.length !== HASH_LEN) {
    throw new Error(`hash must decode to ${HASH_LEN} bytes (got ${hashBytes.length})`);
  }
  if (saltBytes.length !== SALT_LEN) {
    throw new Error(`salt must decode to ${SALT_LEN} bytes (got ${saltBytes.length})`);
  }
  return { hash: p['hash'], salt: p['salt'], ...params };
}

@Injectable()
export class BreakglassService implements OnModuleInit {
  private provisioned = false;
  // Dummy constants for timing parity on username-miss (see breakglass-admin.md §timing-oracle).
  // Set once in onModuleInit; never change after that.
  private dummyHash!: Buffer;
  private dummySalt!: Buffer;

  constructor(
    @InjectPinoLogger(BreakglassService.name) private readonly logger: PinoLogger,
    private readonly sessions: SessionTokenService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Always compute the dummy hash first — ensures timing parity even if bootstrap is skipped.
    this.dummySalt = randomBytes(16);
    const dummyHashBytes = await argon2idAsync(randomBytes(32), this.dummySalt, {
      ...PARAMS,
      dkLen: HASH_LEN,
    });
    this.dummyHash = Buffer.from(dummyHashBytes);

    const content = resolveBootstrapFile();
    if (!content) {
      this.logger.warn(
        'breakglass: ADMIN_BOOTSTRAP_HASH_FILE not set or empty — breakglass login disabled',
      );
      return;
    }

    let parsed: BootstrapHash;
    try {
      parsed = parseBootstrapFile(content);
    } catch (err) {
      this.logger.error(
        `breakglass: invalid bootstrap hash file (${String(err)}) — breakglass login disabled`,
      );
      return;
    }

    try {
      await this.bootstrapAdmin(parsed);
      this.provisioned = true;
    } catch (err) {
      this.logger.error(
        `breakglass: bootstrap failed (${String(err)}) — breakglass login disabled`,
      );
    }
  }

  private async bootstrapAdmin(hash: BootstrapHash): Promise<void> {
    // Pre-flight: if the credential row already exists, we're done. Without this check the insert
    // loop would try to insert a users row first; that hits users_tenant_display_name_idx (unique
    // on display_name per tenant) with 23505 before ever reaching the admin_credentials guard,
    // leaving provisioned=false even though the credential is present and valid.
    const existing = await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      return tx
        .select({ id: schema.adminCredentials.id })
        .from(schema.adminCredentials)
        .limit(1)
        .then((r) => r[0] ?? null);
    });
    if (existing) {
      this.logger.info('breakglass: admin credentials already bootstrapped (idempotent)');
      return;
    }

    // Retry loop handles the extremely rare case where generateArgusId() collides with an
    // existing argus_id — matches the collision-detection pattern in webauthn.service.ts.
    for (let attempt = 0; attempt < 10; attempt++) {
      const argusId = generateArgusId();
      try {
        await this.insertAdminAccount(argusId, hash);
        this.logger.info({ argusId }, 'breakglass: admin account bootstrapped');
        return;
      } catch (err) {
        if (isArgusIdCollision(err)) continue;
        // Two pods racing: one wins the users insert, the other hits 23505 on either the
        // users_tenant_display_name_idx or admin_credentials_tenant_username_idx — both are
        // idempotent signals that the credential now exists.
        const e = err as { code?: string; constraint_name?: string; constraint?: string };
        const constraint = String(e.constraint_name ?? e.constraint ?? '');
        if (
          e.code === '23505' &&
          (constraint.includes('admin_credentials') ||
            constraint === 'users_tenant_display_name_idx')
        ) {
          this.logger.info('breakglass: admin credentials already bootstrapped (idempotent)');
          return;
        }
        throw err;
      }
    }
    throw new Error('breakglass: argus_id collision exhausted after 10 attempts');
  }

  private async insertAdminAccount(argusId: string, hash: BootstrapHash): Promise<void> {
    const sub = `argusid:${argusId}`;
    await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({
          tenantId: DEFAULT_TENANT_ID,
          argusId,
          externalIdentityId: sub,
          displayName: 'breakglass-admin',
          role: 'admin',
          status: 'active',
        })
        .returning({ id: schema.users.id });

      if (!user) throw new Error('user insert returned no row');

      await tx.insert(schema.adminCredentials).values({
        tenantId: DEFAULT_TENANT_ID,
        userId: user.id,
        username: 'admin',
        passwordHash: hash.hash,
        salt: hash.salt,
        kdfParams: { m: hash.m, t: hash.t, p: hash.p },
      });
    });
  }

  async login(
    username: string,
    password: string,
    requestContext: { ip: string; userAgent: string },
  ): Promise<MintedSession> {
    if (!this.provisioned) {
      throw new ServiceUnavailableException('breakglass not provisioned');
    }

    // SELECT FOR UPDATE serializes concurrent login attempts on the same credential row so that
    // the lockout check, the KDF, and the counter update are fully atomic. Without this, a burst
    // of concurrent wrong-password requests can all read a not-yet-locked row, all run the 64 MiB
    // KDF, and then all atomically increment — letting the burst exceed MAX_ATTEMPTS before
    // locked_until is ever set (the atomic SQL increment was correct but not sufficient).
    // FOR UPDATE means only one request holds the row lock at a time; others block at the SELECT
    // until the preceding request commits (after its KDF + counter update). The KDF runs inside
    // the transaction — holding the DB connection for ~1–3 s per attempt — which is acceptable
    // for an emergency endpoint that is rate-limited and expected to be used rarely.
    // Pre-generate the refresh token pair before the credential tx. This way the auth_sessions
    // INSERT can happen inside the same tx as the lockout-reset, closing the race where a
    // concurrent rotate() revokes active sessions AFTER this login passes the KDF but BEFORE
    // mintSession() creates the new session row (which would otherwise escape revocation).
    const { refreshToken, refreshTokenHash, expiresAt } = this.sessions.generateRefreshToken();

    type LoginResult =
      | { outcome: 'not_found' }
      | { outcome: 'locked' }
      | { outcome: 'failed' }
      | {
          outcome: 'ok';
          userId: string;
          sub: string;
          sessionId: string;
          refreshToken: string;
          expiresAt: Date;
        };

    const result = (await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.adminCredentials.id,
          userId: schema.adminCredentials.userId,
          passwordHash: schema.adminCredentials.passwordHash,
          salt: schema.adminCredentials.salt,
          kdfParams: schema.adminCredentials.kdfParams,
          failedAttempts: schema.adminCredentials.failedAttempts,
          lockedUntil: schema.adminCredentials.lockedUntil,
          sub: schema.users.externalIdentityId,
        })
        .from(schema.adminCredentials)
        .innerJoin(schema.users, eq(schema.adminCredentials.userId, schema.users.id))
        .where(eq(schema.adminCredentials.username, username))
        .for('update', { of: schema.adminCredentials })
        .limit(1);

      if (!row) return { outcome: 'not_found' as const };

      // Lockout check BEFORE KDF — prevents a locked account from being a free Argon2id-DoS
      // amplifier (breakglass-admin.md §lockout-policy). Returns 429 so the operator knows
      // the account is locked (not that their credentials are wrong).
      if (row.lockedUntil && row.lockedUntil > new Date()) {
        return { outcome: 'locked' as const };
      }

      // Run KDF while holding the row lock (via FOR UPDATE above). Re-validate params on every
      // login as defence-in-depth — catches a manual DB edit below the floor.
      const params = row.kdfParams as KdfParams;
      assertParams(params);
      const saltBytes = Buffer.from(row.salt, 'base64');
      const storedBytes = Buffer.from(row.passwordHash, 'base64');
      const candidateBytes = Buffer.from(
        await argon2idAsync(Buffer.from(password, 'utf8'), saltBytes, {
          ...params,
          dkLen: HASH_LEN,
        }),
      );
      const match = timingSafeEqual(candidateBytes, storedBytes);

      if (!match) {
        // Atomic increment+lockout — also resets an expired lockout window so a single bad
        // attempt after the window expires doesn't re-extend it indefinitely.
        await tx
          .update(schema.adminCredentials)
          .set({
            failedAttempts: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN 1 ELSE ${schema.adminCredentials.failedAttempts} + 1 END`,
            lockedUntil: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN NULL WHEN ${schema.adminCredentials.failedAttempts} + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '1 millisecond' * ${LOCKOUT_DURATION_MS} ELSE NULL END`,
            updatedAt: new Date(),
          })
          .where(eq(schema.adminCredentials.id, row.id));
        return { outcome: 'failed' as const };
      }

      // Success — reset lockout state inside the same tx.
      await tx
        .update(schema.adminCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.adminCredentials.id, row.id));

      // Insert the session row inside the credential tx so a concurrent rotate() cannot revoke
      // it before we return — the rotate() FOR UPDATE on admin_credentials blocks until this tx
      // commits (including the auth_sessions INSERT below). See breakglass-admin.md §session-revocation-on-rotate.
      await tx
        .insert(schema.userTenantIndex)
        .values({ sub: row.sub, tenantId: DEFAULT_TENANT_ID })
        .onConflictDoNothing();
      const [sessionRow] = await tx
        .insert(schema.authSessions)
        .values({
          tenantId: DEFAULT_TENANT_ID,
          userId: row.userId,
          sub: row.sub,
          refreshTokenHash,
          expiresAt,
        })
        .returning({ id: schema.authSessions.id });
      if (!sessionRow) throw new Error('failed to create session row');

      return {
        outcome: 'ok' as const,
        userId: row.userId,
        sub: row.sub,
        sessionId: sessionRow.id,
        refreshToken,
        expiresAt,
      };
    })) as LoginResult;

    // 'not_found': run dummy KDF for timing parity, then reject — identical response as wrong password.
    if (result.outcome === 'not_found') {
      await argon2idAsync(Buffer.from(password, 'utf8'), this.dummySalt, {
        ...PARAMS,
        dkLen: HASH_LEN,
      });
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.login_failed',
        actorSub: null,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      authAttempts.inc({ result: 'failure', method: 'breakglass' });
      throw new UnauthorizedException('invalid credentials');
    }

    if (result.outcome === 'locked') {
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.locked',
        actorSub: null,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      authAttempts.inc({ result: 'failure', method: 'breakglass' });
      throw new HttpException('Account locked', HttpStatus.TOO_MANY_REQUESTS);
    }

    if (result.outcome === 'failed') {
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.login_failed',
        actorSub: null,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      authAttempts.inc({ result: 'failure', method: 'breakglass' });
      throw new UnauthorizedException('invalid credentials');
    }

    // outcome === 'ok'
    authAttempts.inc({ result: 'success', method: 'breakglass' });
    await this.audit.record(DEFAULT_TENANT_ID, {
      eventType: 'breakglass.login_succeeded',
      actorSub: result.sub,
      ip: requestContext.ip || null,
      userAgent: requestContext.userAgent || null,
    });

    const accessToken = await this.sessions.signSession(
      result.sub,
      result.sessionId,
      result.userId,
    );
    return {
      accessToken,
      refreshToken: result.refreshToken,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  async rotate(
    userId: string,
    currentPassword: string,
    newPassword: string,
    requestContext: { ip: string; userAgent: string },
  ): Promise<void> {
    // FOR UPDATE serializes concurrent rotate attempts (same race as login — an attacker with a
    // stolen bearer token could burst concurrent guesses at currentPassword). Both KDF calls
    // (verify current + hash new) run inside the transaction so the lock is held end-to-end.
    type RotateResult =
      | { outcome: 'not_found' }
      | { outcome: 'locked' }
      | { outcome: 'failed'; sub: string }
      | { outcome: 'ok'; sub: string };

    const result = (await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.adminCredentials.id,
          passwordHash: schema.adminCredentials.passwordHash,
          salt: schema.adminCredentials.salt,
          kdfParams: schema.adminCredentials.kdfParams,
          failedAttempts: schema.adminCredentials.failedAttempts,
          lockedUntil: schema.adminCredentials.lockedUntil,
          sub: schema.users.externalIdentityId,
        })
        .from(schema.adminCredentials)
        .innerJoin(schema.users, eq(schema.adminCredentials.userId, schema.users.id))
        .where(eq(schema.adminCredentials.userId, userId))
        .for('update', { of: schema.adminCredentials })
        .limit(1);

      if (!row) return { outcome: 'not_found' as const };

      if (row.lockedUntil && row.lockedUntil > new Date()) {
        return { outcome: 'locked' as const };
      }

      // Verify current password through the shared lockout counter
      // (rotate must not be an unthrottled oracle — breakglass-admin.md §rotate-re-auth-gate).
      const params = row.kdfParams as KdfParams;
      assertParams(params);
      const saltBytes = Buffer.from(row.salt, 'base64');
      const candidateBytes = Buffer.from(
        await argon2idAsync(Buffer.from(currentPassword, 'utf8'), saltBytes, {
          ...params,
          dkLen: HASH_LEN,
        }),
      );
      const match = timingSafeEqual(candidateBytes, Buffer.from(row.passwordHash, 'base64'));

      if (!match) {
        await tx
          .update(schema.adminCredentials)
          .set({
            failedAttempts: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN 1 ELSE ${schema.adminCredentials.failedAttempts} + 1 END`,
            lockedUntil: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN NULL WHEN ${schema.adminCredentials.failedAttempts} + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '1 millisecond' * ${LOCKOUT_DURATION_MS} ELSE NULL END`,
            updatedAt: new Date(),
          })
          .where(eq(schema.adminCredentials.id, row.id));
        return { outcome: 'failed' as const, sub: row.sub };
      }

      // Hash the new password with fresh salt inside the same tx.
      const newSalt = randomBytes(16);
      const newHash = Buffer.from(
        await argon2idAsync(Buffer.from(newPassword, 'utf8'), newSalt, {
          ...PARAMS,
          dkLen: HASH_LEN,
        }),
      );

      await tx
        .update(schema.adminCredentials)
        .set({
          passwordHash: newHash.toString('base64'),
          salt: newSalt.toString('base64'),
          kdfParams: PARAMS,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.adminCredentials.id, row.id));

      // Revoke all active sessions atomically with the password change. Doing this outside the
      // transaction would leave a crash-recovery window where the new password is committed but
      // old refresh tokens still work — the exact scenario we're rotating to defend against.
      await tx
        .update(schema.authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.authSessions.userId, userId), isNull(schema.authSessions.revokedAt)));

      return { outcome: 'ok' as const, sub: row.sub };
    })) as RotateResult;

    if (result.outcome === 'not_found') {
      throw new ServiceUnavailableException('breakglass not provisioned');
    }

    if (result.outcome === 'locked') {
      throw new HttpException('Account locked', HttpStatus.TOO_MANY_REQUESTS);
    }

    if (result.outcome === 'failed') {
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.rotate_failed',
        actorSub: result.sub,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      throw new UnauthorizedException('invalid current password');
    }

    // outcome === 'ok' — session revocation already committed inside the tx above.

    await this.audit.record(DEFAULT_TENANT_ID, {
      eventType: 'breakglass.rotated',
      actorSub: result.sub,
      ip: requestContext.ip || null,
      userAgent: requestContext.userAgent || null,
    });
  }
}
