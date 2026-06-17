import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../audit/audit.service.js';
import { getDb } from '../db/index.js';
import { SessionTokenService } from './session-token.service.js';
import { BreakglassService, DEFAULT_TENANT_ID } from './breakglass.service.js';

// DB integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
// To run:
//   docker run -d --name argus-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=argus \
//     -p 55432:5432 public.ecr.aws/docker/library/postgres:16-alpine
//   export DATABASE_URL=postgres://postgres:postgres@localhost:55432/argus
//   pnpm --filter @argus/api db:migrate
//   pnpm --filter @argus/api test
const DB_URL = process.env['DATABASE_URL'];

// Use minimum params so the 64 MiB KDF doesn't slow CI to a crawl.
// The floor check (m≥8192, t≥2, p≥1) still validates.
const TEST_PARAMS = { m: 8192, t: 2, p: 1 };
const TEST_PASS = 'TestBreakglass12!';
const TEST_HASH_FILE = '/tmp/argus-test-admin-hash.json';
const CTX = { ip: '127.0.0.1', userAgent: 'vitest' };

async function makeHashFile(password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = Buffer.from(
    await argon2idAsync(Buffer.from(password, 'utf8'), salt, { ...TEST_PARAMS, dkLen: 32 }),
  );
  writeFileSync(
    TEST_HASH_FILE,
    JSON.stringify({
      hash: hash.toString('base64'),
      salt: salt.toString('base64'),
      ...TEST_PARAMS,
    }),
  );
}

async function makeService(): Promise<BreakglassService> {
  const kp = await generateKeyPair('EdDSA', { extractable: true });
  return new BreakglassService(
    new SessionTokenService(kp.privateKey as CryptoKey),
    new AuditService(),
  );
}

describe.skipIf(!DB_URL)('BreakglassService (DB integration)', () => {
  let svc: BreakglassService;
  let sql: ReturnType<typeof getDb>['sql'];

  beforeAll(async () => {
    sql = getDb().sql;
    // Clean up any breakglass state from prior runs (owner connection bypasses RLS).
    await sql`delete from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}`;
    await sql`
      delete from users
      where tenant_id = ${DEFAULT_TENANT_ID}
        and role = 'admin'
        and display_name = 'breakglass-admin'
    `;
    await sql`delete from auth_sessions where tenant_id = ${DEFAULT_TENANT_ID}`;
    await sql`delete from user_tenant_index where tenant_id = ${DEFAULT_TENANT_ID}`;

    // Write hash file and provision the service.
    await makeHashFile(TEST_PASS);
    process.env['ADMIN_BOOTSTRAP_HASH_FILE'] = TEST_HASH_FILE;

    svc = await makeService();
    await svc.onModuleInit();
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}`;
      await sql`
        delete from users
        where tenant_id = ${DEFAULT_TENANT_ID}
          and role = 'admin'
          and display_name = 'breakglass-admin'
      `;
      await sql`delete from auth_sessions where tenant_id = ${DEFAULT_TENANT_ID}`;
      await sql`delete from user_tenant_index where tenant_id = ${DEFAULT_TENANT_ID}`;
      await sql.end({ timeout: 5 });
    }
    delete process.env['ADMIN_BOOTSTRAP_HASH_FILE'];
  });

  it('bootstrap is idempotent — second onModuleInit does not throw', async () => {
    // Running onModuleInit again with the same file must hit the 23505 guard and log "already bootstrapped".
    const svc2 = await makeService();
    await expect(svc2.onModuleInit()).resolves.toBeUndefined();
  });

  it('login happy path returns a valid session', async () => {
    await sql`update admin_credentials set failed_attempts = 0, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    const session = await svc.login('admin', TEST_PASS, CTX);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.expiresAt).toBeInstanceOf(Date);
  });

  it('wrong password → 401 and counter increments', async () => {
    await sql`update admin_credentials set failed_attempts = 0, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    await expect(svc.login('admin', 'WrongPassword!', CTX)).rejects.toThrow(UnauthorizedException);
    const [row] = await sql<{ failed_attempts: number }[]>`
      select failed_attempts from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    expect(row?.failed_attempts).toBe(1);
  });

  it('unknown username → 401 (not 503, same error class as wrong password)', async () => {
    // Timing path: still runs dummy Argon2id, then returns the same 401.
    await expect(svc.login('nonexistent', TEST_PASS, CTX)).rejects.toThrow(UnauthorizedException);
  });

  it('lockout after 5 failures → 423 on next attempt', async () => {
    await sql`update admin_credentials set failed_attempts = 4, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    // Fifth failure triggers lockout
    await expect(svc.login('admin', 'WrongPassword!', CTX)).rejects.toThrow(UnauthorizedException);
    const [row] = await sql<{ locked_until: Date | null }[]>`
      select locked_until from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    expect(row?.locked_until).not.toBeNull();
    // Subsequent attempt — even with correct password — returns 423
    const err = await svc.login('admin', TEST_PASS, CTX).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(429);
  });

  it('login success resets the lockout counter', async () => {
    await sql`update admin_credentials set failed_attempts = 3, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    await svc.login('admin', TEST_PASS, CTX);
    const [row] = await sql<{ failed_attempts: number }[]>`
      select failed_attempts from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    expect(row?.failed_attempts).toBe(0);
  });

  it('rotate: changes the password; old password fails, new one succeeds', async () => {
    await sql`update admin_credentials set failed_attempts = 0, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    const [cred1] = await sql<{ user_id: string }[]>`
      select user_id from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    const user_id = cred1!.user_id;
    const newPass = 'RotatedPass456!';
    await svc.rotate(user_id, TEST_PASS, newPass, CTX);

    await expect(svc.login('admin', TEST_PASS, CTX)).rejects.toThrow(UnauthorizedException);
    const session = await svc.login('admin', newPass, CTX);
    expect(session.accessToken).toBeTruthy();

    // Rotate back so subsequent tests still work
    await sql`update admin_credentials set failed_attempts = 0, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    await svc.rotate(user_id, newPass, TEST_PASS, CTX);
  });

  it('rotate: wrong current password increments the shared lockout counter', async () => {
    await sql`update admin_credentials set failed_attempts = 0, locked_until = null where tenant_id = ${DEFAULT_TENANT_ID}`;
    const [cred2] = await sql<{ user_id: string }[]>`
      select user_id from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    const user_id = cred2!.user_id;
    await expect(svc.rotate(user_id, 'WrongCurrent!', 'NewPass789!', CTX)).rejects.toThrow(
      UnauthorizedException,
    );
    const [row] = await sql<{ failed_attempts: number }[]>`
      select failed_attempts from admin_credentials where tenant_id = ${DEFAULT_TENANT_ID}
    `;
    expect(row?.failed_attempts).toBe(1);
  });

  it('unprovisioned service → 503', async () => {
    const orig = process.env['ADMIN_BOOTSTRAP_HASH_FILE'];
    delete process.env['ADMIN_BOOTSTRAP_HASH_FILE'];
    const unprov = await makeService();
    await unprov.onModuleInit();
    await expect(unprov.login('admin', TEST_PASS, CTX)).rejects.toThrow(
      ServiceUnavailableException,
    );
    // Restore for subsequent tests
    if (orig) process.env['ADMIN_BOOTSTRAP_HASH_FILE'] = orig;
  });
});
