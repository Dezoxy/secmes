import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDatabaseUrl } from './index.js';

// Invariant #5: the DB password (embedded in the connection URL) must NOT be sourced from env in prod — it is
// delivered as a credential FILE (systemd LoadCredential, populated from Key Vault via the VM Managed
// Identity). Env is the LOCAL-dev fallback only. Mirrors the S3_SECRET_ACCESS_KEY_FILE resolution.
describe('resolveDatabaseUrl — secret delivery (invariant #5)', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dburl-'));
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_FILE;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the URL from DATABASE_URL_FILE (trimmed) and ignores the env var', () => {
    const f = join(dir, 'db-url');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    writeFileSync(f, 'postgres://argus:filepw@postgres:5432/argus\n'); // mounted secrets often have a newline
    process.env.DATABASE_URL_FILE = f;
    process.env.DATABASE_URL = 'postgres://argus:envpw@postgres:5432/argus';
    expect(resolveDatabaseUrl()).toBe('postgres://argus:filepw@postgres:5432/argus');
  });

  it('falls back to DATABASE_URL env when no file is set (local dev)', () => {
    process.env.DATABASE_URL = 'postgres://argus:envpw@localhost:5432/argus';
    expect(resolveDatabaseUrl()).toBe('postgres://argus:envpw@localhost:5432/argus');
  });

  it('throws when DATABASE_URL_FILE points at an unreadable file (fail fast, no silent env fallback)', () => {
    process.env.DATABASE_URL_FILE = join(dir, 'does-not-exist');
    process.env.DATABASE_URL = 'postgres://argus:envpw@localhost:5432/argus';
    expect(() => resolveDatabaseUrl()).toThrow();
  });

  it('returns undefined when neither file nor env is set', () => {
    expect(resolveDatabaseUrl()).toBeUndefined();
  });
});
