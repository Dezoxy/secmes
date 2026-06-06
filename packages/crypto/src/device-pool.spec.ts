import { describe, expect, it } from 'vitest';

import {
  MlsEngine,
  deserializeDeviceKeysArray,
  deserializeKeyPackage,
  deviceIdentity,
  serializeDeviceKeysArray,
  serializeKeyPackage,
} from './index.js';

// The KeyPackage POOL the device publishes to the directory (#19, provisioning Slice 2): one-time
// KeyPackages under the stable signature identity, serialized for the wire and persisted with their
// privates (retained so the Welcome sealed to one can be joined).

describe('device KeyPackage pool (provisioning)', () => {
  it('mintKeyPackage keeps the signature identity but makes a fresh one-time KeyPackage', async () => {
    const engine = await MlsEngine.create();
    const device = await engine.generateDeviceKeys('alice@t');
    const member = await engine.mintKeyPackage(device);
    // same STABLE identity: same identity string + same Ed25519 signature key (→ same fingerprint)
    expect(deviceIdentity(member)).toBe(deviceIdentity(device));
    expect(Array.from(member.publicPackage.leafNode.signaturePublicKey)).toEqual(
      Array.from(device.publicPackage.leafNode.signaturePublicKey),
    );
    // but a DIFFERENT KeyPackage (fresh HPKE init key → genuinely one-time), and each mint is distinct
    const member2 = await engine.mintKeyPackage(device);
    const a = serializeKeyPackage(member.publicPackage);
    const b = serializeKeyPackage(member2.publicPackage);
    expect(a).not.toBe(serializeKeyPackage(device.publicPackage));
    expect(a).not.toBe(b);
  });

  it('a published→claimed KeyPackage joins the group with its retained private (end-to-end)', async () => {
    const engine = await MlsEngine.create();
    const inviter = await engine.generateDeviceKeys('inviter@t');
    const recipient = await engine.generateDeviceKeys('recipient@t');

    // recipient mints a pool member, "publishes" its public (serialize); inviter "claims" it (deserialize)
    const poolMember = await engine.mintKeyPackage(recipient);
    const claimed = deserializeKeyPackage(serializeKeyPackage(poolMember.publicPackage));

    // inviter adds the claimed KeyPackage; recipient joins with the RETAINED pool-member private
    const conv = await engine.createConversation('c1', inviter);
    const invite = await conv.addMember(claimed);
    const joined = await engine.joinConversation(poolMember, invite);

    expect(await joined.decrypt(await conv.encrypt('hello pool'))).toBe('hello pool');
  });

  it('serializeDeviceKeysArray round-trips the pool; a restored member still joins', async () => {
    const engine = await MlsEngine.create();
    const device = await engine.generateDeviceKeys('bob@t');
    const pool = [await engine.mintKeyPackage(device), await engine.mintKeyPackage(device)];

    const restored = deserializeDeviceKeysArray(serializeDeviceKeysArray(pool));
    expect(restored).toHaveLength(2);
    // faithful round-trip: a restored member's public KeyPackage matches the original byte-for-byte
    expect(serializeKeyPackage(restored[0]!.publicPackage)).toBe(
      serializeKeyPackage(pool[0]!.publicPackage),
    );

    // the private survived the round-trip: a restored member can still join a group it's added to
    const inviter = await engine.generateDeviceKeys('inviter2@t');
    const conv = await engine.createConversation('c2', inviter);
    const invite = await conv.addMember(restored[1]!.publicPackage);
    const joined = await engine.joinConversation(restored[1]!, invite);
    expect(await joined.decrypt(await conv.encrypt('pool join'))).toBe('pool join');
  });
});
