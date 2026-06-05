import { describe, expect, it } from 'vitest';

import { MlsEngine } from './index.js';

// Smoke tests for checkpoint 17 — local MLS encrypt/decrypt over the ts-mls wrapper.
describe('MLS wrapper (checkpoint 17)', () => {
  it('two devices exchange an encrypted message end to end', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice');
    const bobKeys = await engine.generateDeviceKeys('bob');

    const alice = await engine.createConversation('conv-1', aliceKeys);
    const invite = await alice.addMember(bobKeys.publicPackage);
    const bob = await engine.joinConversation(bobKeys, invite);

    const wire = await alice.encrypt('hello bob');
    expect(await bob.decrypt(wire)).toBe('hello bob');
  });

  it('ratchets across multiple messages, both directions', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice');
    const bobKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv-2', aliceKeys);
    const bob = await engine.joinConversation(
      bobKeys,
      await alice.addMember(bobKeys.publicPackage),
    );

    expect(await bob.decrypt(await alice.encrypt('a1'))).toBe('a1');
    expect(await bob.decrypt(await alice.encrypt('a2'))).toBe('a2');
    expect(await alice.decrypt(await bob.encrypt('b1'))).toBe('b1');
  });

  it('round-trips unicode payloads', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice');
    const bobKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv-3', aliceKeys);
    const bob = await engine.joinConversation(
      bobKeys,
      await alice.addMember(bobKeys.publicPackage),
    );

    const msg = 'szia Bob — üzenet 🔐 日本語';
    expect(await bob.decrypt(await alice.encrypt(msg))).toBe(msg);
  });

  it('serializes concurrent operations — no ratchet/nonce reuse', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice');
    const bobKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv-5', aliceKeys);
    const bob = await engine.joinConversation(
      bobKeys,
      await alice.addMember(bobKeys.publicPackage),
    );

    // Fire two encrypts before the first resolves. Without per-conversation serialization both would
    // use the same ratchet generation and the second wouldn't decrypt; the lock makes them sequential.
    const [w1, w2] = await Promise.all([alice.encrypt('first'), alice.encrypt('second')]);
    expect(await bob.decrypt(w1)).toBe('first');
    expect(await bob.decrypt(w2)).toBe('second');
  });

  it('rejects bytes that are not a valid application message', async () => {
    const engine = await MlsEngine.create();
    const keys = await engine.generateDeviceKeys('solo');
    const conv = await engine.createConversation('conv-4', keys);
    await expect(conv.decrypt(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
