import { describe, expect, it } from 'vitest';

import { createE2eeSession, verifyE2ee } from './mls';

// Proves the browser does a genuine MLS (RFC 9420) round-trip via @argus/crypto, and that the wire
// bytes are server-blind (no plaintext). This is the client-side counterpart of the 16a headless oracle.
describe('in-browser MLS E2EE', () => {
  it('round-trips: the peer decrypts exactly what was encrypted', async () => {
    const session = await createE2eeSession('spec-roundtrip');
    const { plaintext } = await session.send('hello, end-to-end world');
    expect(plaintext).toBe('hello, end-to-end world');
  });

  it('is server-blind: the plaintext never appears in the wire bytes', async () => {
    const session = await createE2eeSession('spec-blind');
    const probe = 'TOP-SECRET-PLAINTEXT-9f3a';
    const { plaintext, ciphertextB64 } = await session.send(probe);
    expect(plaintext).toBe(probe);
    expect(atob(ciphertextB64)).not.toContain(probe);
  });

  it('advances the ratchet: consecutive messages both decrypt', async () => {
    const session = await createE2eeSession('spec-ratchet');
    expect((await session.send('first')).plaintext).toBe('first');
    expect((await session.send('second')).plaintext).toBe('second');
  });

  it('verifyE2ee() passes', async () => {
    expect(await verifyE2ee()).toBe(true);
  });
});
