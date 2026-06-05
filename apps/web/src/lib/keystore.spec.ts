import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { MlsEngine } from '@secmes/crypto';

import { DeviceKeystore } from './keystore';

describe('DeviceKeystore (checkpoint 18)', () => {
  // Fresh IndexedDB per test — fake-indexeddb/auto's instance otherwise persists across tests.
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it('generates, persists, and reloads a working device key', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine);

    const k1 = await ks.getOrCreateDevice('alice-device');
    const k2 = await ks.getOrCreateDevice('alice-device'); // idempotent — same device
    expect(k2).toEqual(k1);

    // A fresh keystore over the same IndexedDB loads the persisted device.
    const reopened = await DeviceKeystore.open(engine);
    const loaded = await reopened.loadDevice('alice-device');
    if (!loaded) throw new Error('expected a persisted device');

    // The reloaded keys must actually work for MLS (structured-clone round trip preserved them).
    const conv = await engine.createConversation('room', loaded);
    const bob = await engine.generateDeviceKeys('bob');
    const invite = await conv.addMember(bob.publicPackage);
    const bobConv = await engine.joinConversation(bob, invite);
    const wire = await conv.encrypt('secret');
    expect(await bobConv.decrypt(wire)).toBe('secret');
  });

  it('is race-safe: concurrent first-runs converge on one device', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine);
    const [a, b] = await Promise.all([
      ks.getOrCreateDevice('race-device'),
      ks.getOrCreateDevice('race-device'),
    ]);
    expect(a).toEqual(b); // no overwrite — both observe the same persisted device
  });

  it('rejects a request for a different identity than the stored device', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine);
    await ks.getOrCreateDevice('first-identity');
    await expect(ks.getOrCreateDevice('other-identity')).rejects.toThrow();
    // loadDevice must not hand another identity the stored private keys.
    await expect(ks.loadDevice('other-identity')).rejects.toThrow();
    expect(await ks.loadDevice('first-identity')).toBeDefined();
  });
});
