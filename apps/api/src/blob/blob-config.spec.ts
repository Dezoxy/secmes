import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadBlobConfig } from './blob-config.js';

// Invariant #5: the long-lived B2 secret must NOT be sourced from the pod env in prod — it is delivered as a
// credential FILE (systemd LoadCredential, populated from Key Vault via the VM Managed Identity). Env is the
// LOCAL-dev (MinIO) fallback only. These tests pin that resolution order + fail-closed behaviour.
describe('loadBlobConfig — secret delivery (invariant #5)', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blobcfg-'));
    process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
    process.env.S3_BUCKET = 'argus-attachments';
    process.env.S3_ACCESS_KEY_ID = 'key-id'; // non-secret half — env is fine
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_SECRET_ACCESS_KEY_FILE;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the secret from S3_SECRET_ACCESS_KEY_FILE (trimmed) and ignores the env var', () => {
    const f = join(dir, 'b2-secret');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    writeFileSync(f, 'file-delivered-secret\n'); // trailing newline is common in mounted secrets
    process.env.S3_SECRET_ACCESS_KEY_FILE = f;
    process.env.S3_SECRET_ACCESS_KEY = 'env-value-must-be-ignored';
    const cfg = loadBlobConfig();
    expect(cfg.secretAccessKey).toBe('file-delivered-secret');
    expect(cfg.configured).toBe(true);
  });

  it('falls back to S3_SECRET_ACCESS_KEY env when no file is set (local dev / MinIO)', () => {
    process.env.S3_SECRET_ACCESS_KEY = 'env-secret';
    const cfg = loadBlobConfig();
    expect(cfg.secretAccessKey).toBe('env-secret');
    expect(cfg.configured).toBe(true);
  });

  it('fails closed (empty secret → not configured) when the secret file is unreadable', () => {
    process.env.S3_SECRET_ACCESS_KEY_FILE = join(dir, 'does-not-exist');
    const cfg = loadBlobConfig();
    expect(cfg.secretAccessKey).toBe('');
    expect(cfg.configured).toBe(false); // -> UnconfiguredBlobStore -> endpoints 503
  });
});
