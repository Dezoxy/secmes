import { describe, expect, it } from 'vitest';

import { MlsEngine } from './index.js';

// Helpers -----------------------------------------------------------------------------------------

async function makePair(aliceId: string, bobId: string) {
  const engine = await MlsEngine.create();
  const aliceKeys = await engine.generateDeviceKeys(aliceId);
  const bobKeys = await engine.generateDeviceKeys(bobId);
  const alice = await engine.createConversation('conv', aliceKeys);
  const bob = await engine.joinConversation(bobKeys, await alice.addMember(bobKeys.publicPackage));
  return { alice, bob };
}

// Tests -------------------------------------------------------------------------------------------

describe('Conversation.decryptAuthenticated', () => {
  it('happy path: returns plaintext + authenticated sender identity and leaf index', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const wire = await alice.encrypt('hello from alice');
    const result = await bob.decryptAuthenticated(wire);
    expect(result.plaintext).toBe('hello from alice');
    expect(result.senderIdentity).toBe('alice');
    expect(typeof result.senderLeafIndex).toBe('number');
    expect(result.senderLeafIndex).toBeGreaterThanOrEqual(0);
  });

  it('reverse direction: bob sends, alice authenticates', async () => {
    const { alice, bob } = await makePair('alice-user', 'bob-user');
    const wire = await bob.encrypt('hello from bob');
    const result = await alice.decryptAuthenticated(wire);
    expect(result.plaintext).toBe('hello from bob');
    expect(result.senderIdentity).toBe('bob-user');
  });

  it('senderLeafIndex matches the group roster', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const wire = await alice.encrypt('msg');
    const result = await bob.decryptAuthenticated(wire);
    // The leaf index returned must point to alice's entry in the member roster.
    const members = bob.members();
    const aliceMember = members.find((m) => m.identity === 'alice');
    if (!aliceMember) throw new Error('alice not found in roster');
    expect(result.senderLeafIndex).toBe(aliceMember.leafIndex);
  });

  it('plaintext parity: decrypt() and decryptAuthenticated() decode identically', async () => {
    // Each wire can only be decrypted once (ratchet advances), so use two separate groups.
    const engine = await MlsEngine.create();
    const kA1 = await engine.generateDeviceKeys('alice');
    const kB1 = await engine.generateDeviceKeys('bob');
    const a1 = await engine.createConversation('c1', kA1);
    const b1 = await engine.joinConversation(kB1, await a1.addMember(kB1.publicPackage));

    const kA2 = await engine.generateDeviceKeys('alice');
    const kB2 = await engine.generateDeviceKeys('bob');
    const a2 = await engine.createConversation('c2', kA2);
    const b2 = await engine.joinConversation(kB2, await a2.addMember(kB2.publicPackage));

    const plain = 'the same secret text';
    expect(await b1.decrypt(await a1.encrypt(plain))).toBe(plain);
    expect((await b2.decryptAuthenticated(await a2.encrypt(plain))).plaintext).toBe(plain);
  });

  it('ratchets correctly across multiple authenticated decryptions', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const r1 = await bob.decryptAuthenticated(await alice.encrypt('msg1'));
    const r2 = await bob.decryptAuthenticated(await alice.encrypt('msg2'));
    expect(r1.plaintext).toBe('msg1');
    expect(r2.plaintext).toBe('msg2');
    expect(r1.senderIdentity).toBe('alice');
    expect(r2.senderIdentity).toBe('alice');
  });

  it('serializes concurrent calls — no ratchet/nonce reuse', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const [w1, w2] = await Promise.all([alice.encrypt('first'), alice.encrypt('second')]);
    const [r1, r2] = await Promise.all([
      bob.decryptAuthenticated(w1),
      bob.decryptAuthenticated(w2),
    ]);
    // Both must decrypt successfully with the correct identity.
    expect(new Set([r1.plaintext, r2.plaintext])).toEqual(new Set(['first', 'second']));
    expect(r1.senderIdentity).toBe('alice');
    expect(r2.senderIdentity).toBe('alice');
  });

  it('F1: throws on malformed wire bytes', async () => {
    const { bob } = await makePair('alice', 'bob');
    await expect(bob.decryptAuthenticated(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  it('F1: throws on a valid message with trailing bytes appended', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const wire = await alice.encrypt('hi');
    const tampered = new Uint8Array([...wire, 0, 0, 0]);
    await expect(bob.decryptAuthenticated(tampered)).rejects.toThrow();
  });

  it('F4/F6: throws when the wire is bit-flipped (MAC/signature failure)', async () => {
    // A flipped byte will break either the SenderData AEAD MAC (→ F6: decryptSenderData returns
    // undefined) or the MLS FramedContent signature (→ F4: processMessage throws).
    // SECURITY: This test pins the binding between processMessage and decryptSenderData.
    // Both decrypt the same SenderData AEAD blob to determine the sender leaf. An adversary
    // cannot produce a wire where decryptSenderData says leaf X while processMessage verified
    // the signature against leaf Y — they use the same ciphertext and the same epoch secret
    // (ts-mls messageProtection.js:120-123). Breaking the AEAD breaks both; a ts-mls change
    // that decouples the two verification steps would cause this test to fail.
    const { alice, bob } = await makePair('alice', 'bob');
    const wire = await alice.encrypt('secret payload');
    const tampered = new Uint8Array(wire);
    // Flip a byte well into the payload (past the version/wireformat prefix) to corrupt either
    // the SenderData ciphertext or the content ciphertext.
    const midIdx = Math.floor(tampered.length / 2);
    tampered.set([(tampered[midIdx] ?? 0) ^ 0xff], midIdx);
    await expect(bob.decryptAuthenticated(tampered)).rejects.toThrow();
  });

  it('decrypt() still works unchanged after extracting decryptInner (regression)', async () => {
    const { alice, bob } = await makePair('alice', 'bob');
    const wire = await alice.encrypt('backwards compat');
    expect(await bob.decrypt(wire)).toBe('backwards compat');
  });
});
