import { describe, expect, it } from 'vitest';

import { deriveSessionKey, openWithKey, sealWithKey, type Argon2Params } from './index.js';

// Min-floor params keep the KDF fast in tests (deriveSessionKey enforces the same floor as sealBackup).
const FAST: Argon2Params = { m: 8192, t: 2, p: 1 };
const salt = () => crypto.getRandomValues(new Uint8Array(16));
const te = new TextEncoder();
const td = new TextDecoder();

describe('session-key sealing', () => {
  it('round-trips bytes under a derived session key', async () => {
    const s = salt();
    const key = await deriveSessionKey('correct horse battery staple', s, FAST);
    const blob = await sealWithKey(key, te.encode('hello history'));
    expect(td.decode(await openWithKey(key, blob))).toBe('hello history');
  });

  it('re-derives the SAME key from the same passphrase + salt (so a reload can open prior seals)', async () => {
    const s = salt();
    const k1 = await deriveSessionKey('pw', s, FAST);
    const blob = await sealWithKey(k1, te.encode('persisted'));
    const k2 = await deriveSessionKey('pw', s, FAST); // fresh unlock, same passphrase + stored salt
    expect(td.decode(await openWithKey(k2, blob))).toBe('persisted');
  });

  it('fails closed on a wrong passphrase or a different salt', async () => {
    const s = salt();
    const key = await deriveSessionKey('pw', s, FAST);
    const blob = await sealWithKey(key, te.encode('secret'));
    const wrongPass = await deriveSessionKey('nope', s, FAST);
    await expect(openWithKey(wrongPass, blob)).rejects.toThrow();
    const wrongSalt = await deriveSessionKey('pw', salt(), FAST);
    await expect(openWithKey(wrongSalt, blob)).rejects.toThrow();
  });

  it('uses a FRESH IV per seal (never reuses (key, IV))', async () => {
    const key = await deriveSessionKey('pw', salt(), FAST);
    const a = await sealWithKey(key, te.encode('same'));
    const b = await sealWithKey(key, te.encode('same'));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext); // distinct IV ⇒ distinct ciphertext for identical input
  });

  it('fails closed on tampering (AES-GCM auth)', async () => {
    const key = await deriveSessionKey('pw', salt(), FAST);
    const blob = await sealWithKey(key, te.encode('integrity'));
    const raw = atob(blob.ciphertext);
    const flipped = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 0x01) + raw.slice(1));
    await expect(openWithKey(key, { iv: blob.iv, ciphertext: flipped })).rejects.toThrow();
  });

  it('rejects a too-short salt', async () => {
    await expect(deriveSessionKey('pw', new Uint8Array(8), FAST)).rejects.toThrow(/salt/);
  });

  it('binds the blob to its context (a relocated blob fails to open)', async () => {
    const key = await deriveSessionKey('pw', salt(), FAST);
    const blob = await sealWithKey(key, te.encode('history'), te.encode('conv-A'));
    expect(td.decode(await openWithKey(key, blob, te.encode('conv-A')))).toBe('history');
    await expect(openWithKey(key, blob, te.encode('conv-B'))).rejects.toThrow(); // wrong slot
    await expect(openWithKey(key, blob)).rejects.toThrow(); // missing context
  });
});
