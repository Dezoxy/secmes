import { describe, expect, it } from 'vitest';

import { deserializeDeviceKeys, MlsEngine, serializeDeviceKeys } from './index.js';

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
});
