import { describe, expect, it } from 'vitest';

import { importUnlockKey, openWithKey, sealWithKey } from './index.js';

const te = new TextEncoder();
const td = new TextDecoder();
const testKey = () => importUnlockKey(crypto.getRandomValues(new Uint8Array(32)));

describe('AES-GCM sealing (sealWithKey / openWithKey)', () => {
  it('round-trips bytes under an imported unlock key', async () => {
    const key = await testKey();
    const blob = await sealWithKey(key, te.encode('hello history'));
    expect(td.decode(await openWithKey(key, blob))).toBe('hello history');
  });

  it('uses a FRESH IV per seal (never reuses (key, IV))', async () => {
    const key = await testKey();
    const a = await sealWithKey(key, te.encode('same'));
    const b = await sealWithKey(key, te.encode('same'));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails closed on a wrong key (AES-GCM auth)', async () => {
    const key = await testKey();
    const blob = await sealWithKey(key, te.encode('secret'));
    const wrongKey = await testKey();
    await expect(openWithKey(wrongKey, blob)).rejects.toThrow();
  });

  it('fails closed on tampering (AES-GCM auth)', async () => {
    const key = await testKey();
    const blob = await sealWithKey(key, te.encode('integrity'));
    const raw = atob(blob.ciphertext);
    const flipped = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 0x01) + raw.slice(1));
    await expect(openWithKey(key, { iv: blob.iv, ciphertext: flipped })).rejects.toThrow();
  });

  it('binds the blob to its context (a relocated blob fails to open)', async () => {
    const key = await testKey();
    const blob = await sealWithKey(key, te.encode('history'), te.encode('conv-A'));
    expect(td.decode(await openWithKey(key, blob, te.encode('conv-A')))).toBe('history');
    await expect(openWithKey(key, blob, te.encode('conv-B'))).rejects.toThrow();
    await expect(openWithKey(key, blob)).rejects.toThrow();
  });
});
