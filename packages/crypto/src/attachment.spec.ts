import { describe, expect, it } from 'vitest';

import { decryptAttachment, encryptAttachment } from './index.js';

describe('attachment content-key encryption', () => {
  it('round-trips a blob under a fresh random content key', async () => {
    const data = crypto.getRandomValues(new Uint8Array(1024));
    const enc = await encryptAttachment(data);
    expect(enc.key).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64 raw key for the MLS envelope
    const dec = await decryptAttachment(enc.key, enc.iv, enc.ciphertext);
    expect(Array.from(dec)).toEqual(Array.from(data));
  });

  it('uses a FRESH key + IV per call (never reuses (key, IV))', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const a = await encryptAttachment(data);
    const b = await encryptAttachment(data);
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  it('fails closed on a wrong content key (a swapped/forged blob is rejected)', async () => {
    const enc = await encryptAttachment(new Uint8Array([9, 9, 9]));
    const other = await encryptAttachment(new Uint8Array([1])); // a different random key
    await expect(decryptAttachment(other.key, enc.iv, enc.ciphertext)).rejects.toThrow();
  });

  it('fails closed on tampered ciphertext (AES-GCM auth)', async () => {
    const enc = await encryptAttachment(new Uint8Array([1, 2, 3, 4]));
    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    await expect(decryptAttachment(enc.key, enc.iv, tampered)).rejects.toThrow();
  });

  it('rejects a malformed key length', async () => {
    const enc = await encryptAttachment(new Uint8Array([1]));
    await expect(decryptAttachment('AAAA', enc.iv, enc.ciphertext)).rejects.toThrow(/32 bytes/);
  });

  it('rejects a malformed IV length', async () => {
    const enc = await encryptAttachment(new Uint8Array([1]));
    await expect(decryptAttachment(enc.key, 'AAAA', enc.ciphertext)).rejects.toThrow(/12 bytes/);
  });

  it('round-trips a zero-byte attachment', async () => {
    const enc = await encryptAttachment(new Uint8Array(0));
    expect((await decryptAttachment(enc.key, enc.iv, enc.ciphertext)).length).toBe(0);
  });
});
