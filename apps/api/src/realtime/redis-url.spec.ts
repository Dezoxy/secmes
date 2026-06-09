import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRedisUrl } from './realtime-bus.module.js';

// Invariant #5: redis requires AUTH, so the URL carries the password — which must NOT be sourced from env in
// prod (it would leak via `docker inspect` / the daemon's at-rest container config). It is delivered as a
// credential FILE (Docker secret, populated from Key Vault via the VM Managed Identity). Env is the LOCAL-dev
// fallback only. Mirrors resolveDatabaseUrl / the S3_SECRET_ACCESS_KEY_FILE resolution.
describe('resolveRedisUrl — secret delivery (invariant #5)', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'redisurl-'));
    delete process.env.REDIS_URL;
    delete process.env.REDIS_URL_FILE;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the URL from REDIS_URL_FILE (trimmed) and ignores the env var', () => {
    const f = join(dir, 'redis-url');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    writeFileSync(f, 'redis://:filepw@redis:6379\n'); // mounted secrets often have a trailing newline
    process.env.REDIS_URL_FILE = f;
    process.env.REDIS_URL = 'redis://:envpw@redis:6379';
    expect(resolveRedisUrl()).toBe('redis://:filepw@redis:6379');
  });

  it('falls back to REDIS_URL env when no file is set (local dev)', () => {
    process.env.REDIS_URL = 'redis://redis:6379';
    expect(resolveRedisUrl()).toBe('redis://redis:6379');
  });

  it('throws when REDIS_URL_FILE points at an unreadable file (fail fast, no silent env fallback)', () => {
    process.env.REDIS_URL_FILE = join(dir, 'does-not-exist');
    process.env.REDIS_URL = 'redis://redis:6379';
    expect(() => resolveRedisUrl()).toThrow();
  });

  it('returns undefined when neither file nor env is set (→ in-process bus)', () => {
    expect(resolveRedisUrl()).toBeUndefined();
  });
});
