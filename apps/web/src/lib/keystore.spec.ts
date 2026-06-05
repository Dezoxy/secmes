import { MlsEngine, type Argon2Params, type DeviceKeys } from '@secmes/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { DeviceKeystore } from './keystore';

// Clears the key-backup Argon2 floor while keeping the seal/unseal fast in tests.
const FAST: Argon2Params = { m: 8192, t: 2, p: 1 };

/** Prove a DeviceKeys works for MLS by exchanging a message; returns the decrypted text. */
async function worksForMls(engine: MlsEngine, keys: DeviceKeys): Promise<string> {
  const conv = await engine.createConversation('room', keys);
  const bob = await engine.generateDeviceKeys('bob');
  const invite = await conv.addMember(bob.publicPackage);
  const bobConv = await engine.joinConversation(bob, invite);
  return bobConv.decrypt(await conv.encrypt('msg'));
}

describe('DeviceKeystore — sealed at rest (checkpoint 18 gate lifted) + recovery (23)', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory(); // fresh IndexedDB per test
  });

  it('generates, seals, persists, and unseals a working device with the passphrase', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await ks.getOrCreateDevice('alice', 'correct horse');
    await ks.getOrCreateDevice('alice', 'correct horse'); // idempotent — same sealed device

    const reopened = await DeviceKeystore.open(engine, FAST);
    const loaded = await reopened.loadDevice('alice', 'correct horse');
    if (!loaded) throw new Error('expected a persisted device');
    expect(await worksForMls(engine, loaded)).toBe('msg');
  });

  it('rejects a wrong passphrase (sealed at rest)', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await ks.getOrCreateDevice('alice', 'right-passphrase');
    await expect(ks.loadDevice('alice', 'wrong-passphrase')).rejects.toThrow();
  });

  it('rejects a different identity on the same profile', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await ks.getOrCreateDevice('alice', 'pw');
    await expect(ks.getOrCreateDevice('bob', 'pw')).rejects.toThrow();
    await expect(ks.loadDevice('bob', 'pw')).rejects.toThrow();
  });

  it('is race-safe: concurrent first-runs converge on one device', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const [a, b] = await Promise.all([
      ks.getOrCreateDevice('alice', 'pw'),
      ks.getOrCreateDevice('alice', 'pw'),
    ]);
    expect(await worksForMls(engine, a)).toBe('msg');
    expect(await worksForMls(engine, b)).toBe('msg');
    expect(await ks.loadDevice('alice', 'pw')).toBeDefined();
  });

  it('recovers on a fresh device from the sealed backup (checkpoint 23)', async () => {
    const engine = await MlsEngine.create();
    // Device 1: create + export the sealed blob (this is what gets uploaded to the server).
    const ks1 = await DeviceKeystore.open(engine, FAST);
    await ks1.getOrCreateDevice('alice', 'my passphrase');
    const blob = await ks1.exportSealedBackup();
    if (!blob) throw new Error('expected a sealed backup');

    // Fresh browser (new IndexedDB): download the blob, unlock with the passphrase.
    globalThis.indexedDB = new IDBFactory();
    const ks2 = await DeviceKeystore.open(engine, FAST);
    await ks2.importSealedBackup('alice', blob);
    const recovered = await ks2.loadDevice('alice', 'my passphrase');
    if (!recovered) throw new Error('recovery failed');
    expect(await worksForMls(engine, recovered)).toBe('msg'); // recovered identity keys work
  });

  it('import rejects a malformed blob and refuses to clobber an existing device', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await expect(ks.importSealedBackup('alice', '{"not":"a backup"}')).rejects.toThrow();

    await ks.getOrCreateDevice('alice', 'pw');
    const blob = await ks.exportSealedBackup();
    if (!blob) throw new Error('expected a backup');
    await expect(ks.importSealedBackup('alice', blob)).rejects.toThrow(); // won't overwrite
  });

  it('drops a legacy unsealed v1 record on upgrade (no stale unseal)', async () => {
    const engine = await MlsEngine.create();
    // Simulate the pre-seal v1 schema: same DB/store/key, an UNSEALED { identity, keys } record.
    const legacyKeys = await engine.generateDeviceKeys('alice');
    const v1 = await openDB('secmes-keystore', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('device')) db.createObjectStore('device');
      },
    });
    await v1.put('device', { identity: 'alice', keys: legacyKeys }, 'self');
    v1.close();

    // Opening at the sealed schema must clear the legacy record, not misread it as a sealed blob.
    const ks = await DeviceKeystore.open(engine, FAST);
    expect(await ks.loadDevice('alice', 'pw')).toBeUndefined(); // legacy gone, nothing to unseal
    const fresh = await ks.getOrCreateDevice('alice', 'pw'); // a fresh sealed device works
    expect(await worksForMls(engine, fresh)).toBe('msg');
  });

  it('rejects a recovered blob whose embedded identity differs from the requested one', async () => {
    const engine = await MlsEngine.create();
    const ks1 = await DeviceKeystore.open(engine, FAST);
    await ks1.getOrCreateDevice('alice', 'shared pw');
    const blob = await ks1.exportSealedBackup();
    if (!blob) throw new Error('expected a backup');

    // Fresh device: the server returns alice's blob but the caller asks for bob (shared passphrase).
    globalThis.indexedDB = new IDBFactory();
    const ks2 = await DeviceKeystore.open(engine, FAST);
    await ks2.importSealedBackup('bob', blob); // metadata says bob; the sealed KeyPackage embeds alice
    // Unseal succeeds (same passphrase) but the signed identity is alice ≠ bob → reject, don't return keys.
    await expect(ks2.loadDevice('bob', 'shared pw')).rejects.toThrow();
  });
});
