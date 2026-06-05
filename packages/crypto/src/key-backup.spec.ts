import { describe, expect, it } from 'vitest';

import { DEFAULT_ARGON2, openBackup, sealBackup, type Argon2Params } from './key-backup.js';

const te = new TextEncoder();
// Smallest params that still clear the MIN_ARGON2 floor (keeps most tests fast); one test exercises
// the real DEFAULT_ARGON2 (64 MiB).
const FAST: Argon2Params = { m: 8192, t: 2, p: 1 };

describe('key backup (checkpoint 21)', () => {
  it('seals and opens round-trip', async () => {
    const secret = te.encode('private device key material');
    const blob = await sealBackup(secret, 'correct horse battery staple', FAST);
    expect(await openBackup(blob, 'correct horse battery staple')).toEqual(secret);
  });

  it('produces a fresh salt + IV each time (no reuse)', async () => {
    const a = await sealBackup(te.encode('x'), 'pw', FAST);
    const b = await sealBackup(te.encode('x'), 'pw', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects a wrong passphrase', async () => {
    const blob = await sealBackup(te.encode('secret'), 'pass-one', FAST);
    await expect(openBackup(blob, 'pass-two')).rejects.toThrow();
  });

  it('rejects tampered ciphertext (AES-GCM auth)', async () => {
    const blob = await sealBackup(te.encode('secret'), 'pw', FAST);
    const tampered = {
      ...blob,
      ciphertext: (blob.ciphertext[0] === 'A' ? 'B' : 'A') + blob.ciphertext.slice(1),
    };
    await expect(openBackup(tampered, 'pw')).rejects.toThrow();
  });

  it('uses the production Argon2id params by default and round-trips', async () => {
    const blob = await sealBackup(te.encode('secret'), 'pw'); // DEFAULT_ARGON2 — 64 MiB (slow)
    expect(blob.params).toEqual(DEFAULT_ARGON2);
    expect(await openBackup(blob, 'pw')).toEqual(te.encode('secret'));
  }, 30_000); // 64 MiB Argon2id in pure JS can exceed vitest's 5s default on a slow CI runner

  it('refuses weak Argon2id params on seal and on open (anti-downgrade floor)', async () => {
    await expect(sealBackup(te.encode('x'), 'pw', { m: 8, t: 1, p: 1 })).rejects.toThrow();
    const ok = await sealBackup(te.encode('x'), 'pw', FAST);
    const downgraded = { ...ok, params: { m: 8, t: 1, p: 1 } as Argon2Params };
    await expect(openBackup(downgraded, 'pw')).rejects.toThrow();
  });

  it('refuses absurd Argon2id params (anti-DoS ceiling) without deriving', async () => {
    await expect(sealBackup(te.encode('x'), 'pw', { m: 2 ** 31, t: 1, p: 1 })).rejects.toThrow();
    const ok = await sealBackup(te.encode('x'), 'pw', FAST);
    const huge = { ...ok, params: { m: 2 ** 31, t: 1, p: 1 } as Argon2Params };
    await expect(openBackup(huge, 'pw')).rejects.toThrow();
  });
});
