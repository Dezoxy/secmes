import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { getDb } from '../db/index.js';
import { KeyBackupService } from './key-backup.service.js';

// Integration (roadmap 22) — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('KeyBackupService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  const svc = new KeyBackupService(new AuditService());

  let aliceAuth: VerifiedAuth;
  let carolAuth: VerifiedAuth;

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('KB-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('KB-B') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'kb-alice', 'al@a.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'kb-carol', 'c@b.test')`;
    aliceAuth = { sub: 'kb-alice', tenantId: tenantA };
    carolAuth = { sub: 'kb-carol', tenantId: tenantB };
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades users/backups
      await sql.end({ timeout: 5 });
    }
  });

  it('stores and fetches the caller backup round-trip', async () => {
    await svc.store(aliceAuth, 'sealed-blob-1');
    expect(await svc.fetch(aliceAuth)).toBe('sealed-blob-1');
  });

  it('replaces the backup on re-store (rotation, one per user)', async () => {
    await svc.store(aliceAuth, 'sealed-blob-2');
    expect(await svc.fetch(aliceAuth)).toBe('sealed-blob-2');
    const [row] = await sql`
      select count(*)::int as n from key_backups kb
      join users u on u.id = kb.user_id where u.external_identity_id = 'kb-alice'`;
    expect(row?.n).toBe(1); // upsert, not append
  });

  it('returns null when no backup exists', async () => {
    expect(await svc.fetch(carolAuth)).toBeNull();
  });

  it('cannot fetch across tenants (RLS)', async () => {
    // Carol (tenant B) sees none of tenant A's backups even though one exists for Alice.
    expect(await svc.fetch(carolAuth)).toBeNull();
  });

  it('audits both store and fetch (drain/overwrite detectability)', async () => {
    await svc.store(aliceAuth, 'sealed-blob-3');
    await svc.fetch(aliceAuth);
    const [stored] = await sql`
      select count(*)::int as n from audit_events
      where tenant_id = ${tenantA} and event_type = 'keybackup.stored'`;
    const [fetched] = await sql`
      select count(*)::int as n from audit_events
      where tenant_id = ${tenantA} and event_type = 'keybackup.fetched'`;
    expect(stored?.n).toBeGreaterThanOrEqual(1);
    expect(fetched?.n).toBeGreaterThanOrEqual(1);
  });
});
