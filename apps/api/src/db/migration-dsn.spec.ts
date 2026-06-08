import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMigrationDsn } from './migration-dsn.js';

// Invariant #5: the migration OWNER DSN (highest-privilege connection) must be deliverable as a credential
// FILE, never required in env. These pin the file-first precedence the deploy relies on.
describe('resolveMigrationDsn — owner DSN delivery (invariant #5)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migdsn-'));
    env = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeFile = (name: string, contents: string): string => {
    const f = join(dir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    writeFileSync(f, contents);
    return f;
  };

  it('prefers MIGRATION_DATABASE_URL_FILE (trimmed) over everything else', () => {
    env.MIGRATION_DATABASE_URL_FILE = writeFile(
      'mig',
      'postgres://argus:ownerpw@postgres:5432/argus\n',
    );
    env.MIGRATION_DATABASE_URL = 'postgres://x:env@h/db';
    env.DATABASE_URL_FILE = writeFile('run', 'postgres://argus_app:apppw@postgres:5432/argus');
    env.DATABASE_URL = 'postgres://x:env2@h/db';
    expect(resolveMigrationDsn(env)).toBe('postgres://argus:ownerpw@postgres:5432/argus');
  });

  it('falls back to MIGRATION_DATABASE_URL env when no migration file is set', () => {
    env.MIGRATION_DATABASE_URL = 'postgres://argus:ownerpw@h:5432/argus';
    env.DATABASE_URL = 'postgres://argus_app:apppw@h:5432/argus';
    expect(resolveMigrationDsn(env)).toBe('postgres://argus:ownerpw@h:5432/argus');
  });

  it('falls back to the runtime DATABASE_URL_FILE when no migration DSN is set (local dev)', () => {
    env.DATABASE_URL_FILE = writeFile('run', 'postgres://argus_app:apppw@h:5432/argus\n');
    expect(resolveMigrationDsn(env)).toBe('postgres://argus_app:apppw@h:5432/argus');
  });

  it('finally falls back to DATABASE_URL env', () => {
    env.DATABASE_URL = 'postgres://argus_app:apppw@localhost:5432/argus';
    expect(resolveMigrationDsn(env)).toBe('postgres://argus_app:apppw@localhost:5432/argus');
  });

  it('returns undefined when nothing is set', () => {
    expect(resolveMigrationDsn(env)).toBeUndefined();
  });
});
