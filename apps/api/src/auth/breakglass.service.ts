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
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { eq, sql } from 'drizzle-orm';

import { schema, withTenant } from '../db/index.js';
import { generateArgusId, isArgusIdCollision } from '../users/argus-id.js';
import { AuditService } from '../audit/audit.service.js';
import { type MintedSession, SessionTokenService } from './session-token.service.js';

// Fixed single-tenant UUID — matches DEFAULT_TENANT_ID in webauthn.service.ts.
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15-minute flat window
const PARAMS = { m: 65536, t: 3, p: 1 }; // matches DEFAULT_ARGON2 in packages/crypto/src/key-backup.ts
const HASH_LEN = 32;
const MIN_PARAMS = { m: 8192, t: 2, p: 1 }; // matches MIN_ARGON2 in packages/crypto/src/key-backup.ts

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
  return { hash: p['hash'], salt: p['salt'], ...params };
}

@Injectable()
export class BreakglassService implements OnModuleInit {
  private readonly logger = new Logger(BreakglassService.name);
  private provisioned = false;
  // Dummy constants for timing parity on username-miss (see breakglass-admin.md §timing-oracle).
  // Set once in onModuleInit; never change after that.
  private dummyHash!: Buffer;
  private dummySalt!: Buffer;

  constructor(
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
      this.logger.log('breakglass: admin credentials already bootstrapped (idempotent)');
      return;
    }

    // Retry loop handles the extremely rare case where generateArgusId() collides with an
    // existing argus_id — matches the collision-detection pattern in webauthn.service.ts.
    for (let attempt = 0; attempt < 10; attempt++) {
      const argusId = generateArgusId();
      try {
        await this.insertAdminAccount(argusId, hash);
        this.logger.log(`breakglass: admin account bootstrapped (argus_id=${argusId})`);
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
          this.logger.log('breakglass: admin credentials already bootstrapped (idempotent)');
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

    // Read credential row + sub in one query.
    const row = await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      return tx
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
        .limit(1)
        .then((r) => r[0] ?? null);
    });

    // Lockout check BEFORE KDF — prevents a locked account from being a free Argon2id-DoS
    // amplifier (breakglass-admin.md §lockout-policy). Returns 423 so the operator knows
    // the account is locked (not that their credentials are wrong).
    if (row?.lockedUntil && row.lockedUntil > new Date()) {
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.locked',
        actorSub: null,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      throw new HttpException('Account locked', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Always run Argon2id — dummy values when username not found (timing parity).
    // Re-validate params on every login (defense-in-depth: catches a manual DB edit below the floor).
    const params = (row?.kdfParams as KdfParams | undefined) ?? PARAMS;
    if (row) assertParams(params);
    const saltBytes = row ? Buffer.from(row.salt, 'base64') : this.dummySalt;
    const storedBytes = row ? Buffer.from(row.passwordHash, 'base64') : this.dummyHash;
    const candidateBytes = Buffer.from(
      await argon2idAsync(Buffer.from(password, 'utf8'), saltBytes, { ...params, dkLen: HASH_LEN }),
    );

    const match = timingSafeEqual(candidateBytes, storedBytes);

    if (!row || !match) {
      if (row) {
        // Atomic increment+lockout — avoids a race where concurrent wrong-password
        // requests each read the same stale count and write it back, allowing more
        // than MAX_ATTEMPTS before the lockout fires (CWE-362).
        // Also resets an expired lockout window: if locked_until IS NOT NULL but has
        // passed, treat this as the first failure of a fresh window (count → 1, no new
        // lockout), preventing a single bad attempt from extending the window indefinitely.
        await withTenant(DEFAULT_TENANT_ID, async (tx) => {
          await tx
            .update(schema.adminCredentials)
            .set({
              failedAttempts: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN 1 ELSE ${schema.adminCredentials.failedAttempts} + 1 END`,
              lockedUntil: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN NULL WHEN ${schema.adminCredentials.failedAttempts} + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '1 millisecond' * ${LOCKOUT_DURATION_MS} ELSE NULL END`,
              updatedAt: new Date(),
            })
            .where(eq(schema.adminCredentials.id, row.id));
        });
      }
      // Always audit login failure — even for an unknown username (actorSub=null, IP+UA only).
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.login_failed',
        actorSub: null,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      throw new UnauthorizedException('invalid credentials');
    }

    // Success — reset lockout state.
    await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      await tx
        .update(schema.adminCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.adminCredentials.id, row.id));
    });
    await this.audit.record(DEFAULT_TENANT_ID, {
      eventType: 'breakglass.login_succeeded',
      actorSub: row.sub,
      ip: requestContext.ip || null,
      userAgent: requestContext.userAgent || null,
    });

    return this.sessions.mintSession({
      tenantId: DEFAULT_TENANT_ID,
      userId: row.userId,
      sub: row.sub,
    });
  }

  async rotate(
    userId: string,
    currentPassword: string,
    newPassword: string,
    requestContext: { ip: string; userAgent: string },
  ): Promise<void> {
    const row = await withTenant(DEFAULT_TENANT_ID, async (tx) => {
      return tx
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
        .limit(1)
        .then((r) => r[0] ?? null);
    });

    if (!row) {
      throw new ServiceUnavailableException('breakglass not provisioned');
    }

    // Lockout check before KDF.
    if (row.lockedUntil && row.lockedUntil > new Date()) {
      throw new HttpException('Account locked', HttpStatus.TOO_MANY_REQUESTS);
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
      await withTenant(DEFAULT_TENANT_ID, async (tx) => {
        await tx
          .update(schema.adminCredentials)
          .set({
            failedAttempts: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN 1 ELSE ${schema.adminCredentials.failedAttempts} + 1 END`,
            lockedUntil: sql`CASE WHEN ${schema.adminCredentials.lockedUntil} IS NOT NULL AND ${schema.adminCredentials.lockedUntil} <= now() THEN NULL WHEN ${schema.adminCredentials.failedAttempts} + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '1 millisecond' * ${LOCKOUT_DURATION_MS} ELSE NULL END`,
            updatedAt: new Date(),
          })
          .where(eq(schema.adminCredentials.id, row.id));
      });
      await this.audit.record(DEFAULT_TENANT_ID, {
        eventType: 'breakglass.rotate_failed',
        actorSub: row.sub,
        ip: requestContext.ip || null,
        userAgent: requestContext.userAgent || null,
      });
      throw new UnauthorizedException('invalid current password');
    }

    // Hash the new password with fresh salt.
    const newSalt = randomBytes(16);
    const newHash = Buffer.from(
      await argon2idAsync(Buffer.from(newPassword, 'utf8'), newSalt, {
        ...PARAMS,
        dkLen: HASH_LEN,
      }),
    );

    await withTenant(DEFAULT_TENANT_ID, async (tx) => {
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
    });

    // Revoke all active sessions for the breakglass user so a compromised-then-rotated
    // credential cannot be kept alive via still-valid refresh tokens.
    await this.sessions.revokeSession(DEFAULT_TENANT_ID, { userId });

    await this.audit.record(DEFAULT_TENANT_ID, {
      eventType: 'breakglass.rotated',
      actorSub: row.sub,
      ip: requestContext.ip || null,
      userAgent: requestContext.userAgent || null,
    });
  }
}
