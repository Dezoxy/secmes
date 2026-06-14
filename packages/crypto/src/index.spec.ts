import { describe, expect, it } from 'vitest';

import { formatDeviceIdentity, MlsEngine, parseDeviceIdentity } from './index.js';

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

  it('rejects a valid message with trailing bytes appended', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice');
    const bobKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv-6', aliceKeys);
    const bob = await engine.joinConversation(
      bobKeys,
      await alice.addMember(bobKeys.publicPackage),
    );

    const wire = await alice.encrypt('hi');
    const tampered = new Uint8Array([...wire, 0, 0, 0]); // valid message + garbage suffix
    await expect(bob.decrypt(tampered)).rejects.toThrow();
  });
});

describe('composite device identity (B2)', () => {
  it('formatDeviceIdentity and parseDeviceIdentity round-trip', () => {
    const userId = '550e8400-e29b-41d4-a716-446655440000';
    const deviceUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const identity = formatDeviceIdentity(userId, deviceUuid);
    expect(identity).toBe(`${userId}:${deviceUuid}`);
    const parsed = parseDeviceIdentity(identity);
    expect(parsed.userId).toBe(userId);
    expect(parsed.deviceUuid).toBe(deviceUuid);
  });

  it('parseDeviceIdentity returns deviceUuid: undefined for legacy format (no colon)', () => {
    const legacy = '550e8400-e29b-41d4-a716-446655440000';
    const parsed = parseDeviceIdentity(legacy);
    expect(parsed.userId).toBe(legacy);
    expect(parsed.deviceUuid).toBeUndefined();
  });

  it('two leaves with same userId but different deviceUuid join the same group without collision', async () => {
    const engine = await MlsEngine.create();
    const userId = 'alice-user-id';
    const aliceD1 = await engine.generateDeviceKeys(formatDeviceIdentity(userId, 'device-uuid-1'));
    const aliceD2 = await engine.generateDeviceKeys(formatDeviceIdentity(userId, 'device-uuid-2'));

    // D1 creates the group and adds D2 — ts-mls must accept both leaves.
    const conv = await engine.createConversation('multi-device-conv', aliceD1);
    const invite = await conv.addMember(aliceD2.publicPackage);
    const d2Conv = await engine.joinConversation(aliceD2, invite);

    // Both devices can encrypt/decrypt — no collision.
    const fromD1 = await conv.encrypt('from d1');
    expect(await d2Conv.decrypt(fromD1)).toBe('from d1');

    const fromD2 = await d2Conv.encrypt('from d2');
    expect(await conv.decrypt(fromD2)).toBe('from d2');
  });
});
