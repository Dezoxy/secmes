import { describe, expect, it } from 'vitest';

import {
  deserializeDeviceIdentity,
  deserializeDeviceKeys,
  deviceIdentity,
  MlsEngine,
  serializeDeviceIdentity,
  serializeDeviceKeys,
} from './index.js';

// Match the codec's own base64 (btoa over Latin-1) so "json does not contain key" is an exact test.
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const bytesEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

describe('device codec', () => {
  it('round-trips DeviceKeys (bigint + Uint8Array) preserving MLS function', async () => {
    const engine = await MlsEngine.create();
    const keys = await engine.generateDeviceKeys('alice');

    const restored = deserializeDeviceKeys(serializeDeviceKeys(keys));

    // The restored keys must still work for MLS end to end.
    const conv = await engine.createConversation('room', restored);
    const bob = await engine.generateDeviceKeys('bob');
    const invite = await conv.addMember(bob.publicPackage);
    const bobConv = await engine.joinConversation(bob, invite);
    expect(await bobConv.decrypt(await conv.encrypt('hi'))).toBe('hi');
  });

  it('identity-only recovery: artifact carries no one-time HPKE keys; mints a fresh working device', async () => {
    const engine = await MlsEngine.create();
    const original = await engine.generateDeviceKeys('alice');

    // The recovery material is identity-only — sign keypair + identity, NO init/hpke private keys.
    const id = engine.exportIdentity(original);
    const bytes = serializeDeviceIdentity(id);
    const json = new TextDecoder().decode(bytes);
    expect(json).not.toContain(b64(original.privatePackage.initPrivateKey));
    expect(json).not.toContain(b64(original.privatePackage.hpkePrivateKey));

    // Round-trip through the codec, then mint a fresh device under the recovered signing identity.
    const restored = deserializeDeviceIdentity(bytes);
    const recovered = await engine.deviceFromIdentity(restored);

    // Same signing identity preserved...
    expect(deviceIdentity(recovered)).toBe('alice');
    expect(
      bytesEq(
        recovered.publicPackage.leafNode.signaturePublicKey,
        original.publicPackage.leafNode.signaturePublicKey,
      ),
    ).toBe(true);
    // ...but a FRESH KeyPackage (new init key → cannot decrypt the original's Welcome): forward secrecy.
    expect(bytesEq(recovered.publicPackage.initKey, original.publicPackage.initKey)).toBe(false);

    // And the recovered device actually works for MLS.
    const conv = await engine.createConversation('room', recovered);
    const bob = await engine.generateDeviceKeys('bob');
    const invite = await conv.addMember(bob.publicPackage);
    const bobConv = await engine.joinConversation(bob, invite);
    expect(await bobConv.decrypt(await conv.encrypt('hi'))).toBe('hi');
  });
});
