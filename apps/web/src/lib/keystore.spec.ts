import {
  MlsEngine,
  deviceIdentity,
  serializeKeyPackage,
  type Argon2Params,
  type DeviceKeys,
} from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { DeviceExistsError, DeviceKeystore } from './keystore';

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

  it('hasDevice reflects whether a sealed device is stored (no passphrase)', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    expect(await ks.hasDevice()).toBe(false);
    await ks.getOrCreateDevice('alice', 'pw');
    expect(await ks.hasDevice()).toBe(true);
    await ks.clearDevice();
    expect(await ks.hasDevice()).toBe(false);
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

  it('recovers on a fresh device from the identity-only artifact (checkpoint 23, FS-preserving)', async () => {
    const engine = await MlsEngine.create();
    // Device 1: create + export the identity-only artifact (this is what gets uploaded to the server).
    const ks1 = await DeviceKeystore.open(engine, FAST);
    await ks1.getOrCreateDevice('alice', 'my passphrase');
    const blob = await ks1.exportRecoveryArtifact('alice', 'my passphrase');
    if (!blob) throw new Error('expected a recovery artifact');

    // Fresh browser (new IndexedDB): download the artifact, unlock with the passphrase on import.
    globalThis.indexedDB = new IDBFactory();
    const ks2 = await DeviceKeystore.open(engine, FAST);
    const recovered = await ks2.importRecoveryArtifact('alice', blob, 'my passphrase');
    expect(await worksForMls(engine, recovered)).toBe('msg'); // recovered identity can message
    const reloaded = await ks2.loadDevice('alice', 'my passphrase');
    if (!reloaded) throw new Error('recovery failed');
    expect(await worksForMls(engine, reloaded)).toBe('msg'); // and the minted device persists
  });

  it('import rejects a malformed blob and refuses to clobber an existing device', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await expect(ks.importRecoveryArtifact('alice', '{"not":"a backup"}', 'pw')).rejects.toThrow();

    await ks.getOrCreateDevice('alice', 'pw');
    const blob = await ks.exportRecoveryArtifact('alice', 'pw');
    if (!blob) throw new Error('expected a backup');
    // Typed sentinel (raised only AFTER the artifact is verified) so the recovery layer can match on it.
    await expect(ks.importRecoveryArtifact('alice', blob, 'pw')).rejects.toBeInstanceOf(
      DeviceExistsError,
    );
  });

  it('a failed import leaves the profile importable (no stranded bad record)', async () => {
    const engine = await MlsEngine.create();
    const ks1 = await DeviceKeystore.open(engine, FAST);
    await ks1.getOrCreateDevice('alice', 'right pw');
    const blob = await ks1.exportRecoveryArtifact('alice', 'right pw');
    if (!blob) throw new Error('expected a backup');

    // Fresh device: a wrong passphrase must NOT persist the (unverified) blob...
    globalThis.indexedDB = new IDBFactory();
    const ks2 = await DeviceKeystore.open(engine, FAST);
    await expect(ks2.importRecoveryArtifact('alice', blob, 'wrong pw')).rejects.toThrow();
    expect(await ks2.loadDevice('alice', 'right pw')).toBeUndefined(); // nothing was written

    // ...so the correct import still succeeds (profile not stranded behind the no-clobber guard).
    const recovered = await ks2.importRecoveryArtifact('alice', blob, 'right pw');
    expect(await worksForMls(engine, recovered)).toBe('msg');
  });

  it('import is race-safe: concurrent imports on a fresh profile pick one winner, no clobber', async () => {
    const engine = await MlsEngine.create();
    // Two distinct recovery artifacts (alice, bob), each minted on its own fresh profile.
    const mintBlob = async (id: string): Promise<string> => {
      globalThis.indexedDB = new IDBFactory();
      const k = await DeviceKeystore.open(engine, FAST);
      await k.getOrCreateDevice(id, 'pw');
      const b = await k.exportRecoveryArtifact(id, 'pw');
      if (!b) throw new Error('expected a backup');
      return b;
    };
    const aliceBlob = await mintBlob('alice');
    const bobBlob = await mintBlob('bob');

    globalThis.indexedDB = new IDBFactory();
    const ks = await DeviceKeystore.open(engine, FAST);
    const results = await Promise.allSettled([
      ks.importRecoveryArtifact('alice', aliceBlob, 'pw'),
      ks.importRecoveryArtifact('bob', bobBlob, 'pw'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // Whichever import won, exactly that identity is stored and unseals to working keys.
    const winner = results[0].status === 'fulfilled' ? 'alice' : 'bob';
    const recovered = await ks.loadDevice(winner, 'pw');
    if (!recovered) throw new Error('expected the winning device');
    expect(await worksForMls(engine, recovered)).toBe('msg');
  });

  it('drops a legacy unsealed v1 record on upgrade (no stale unseal)', async () => {
    const engine = await MlsEngine.create();
    // Simulate the pre-seal v1 schema: same DB/store/key, an UNSEALED { identity, keys } record.
    const legacyKeys = await engine.generateDeviceKeys('alice');
    const v1 = await openDB('argus-keystore', 1, {
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
    const blob = await ks1.exportRecoveryArtifact('alice', 'shared pw');
    if (!blob) throw new Error('expected a backup');

    // Fresh device: the server returns alice's artifact but the caller asks for bob (shared passphrase).
    globalThis.indexedDB = new IDBFactory();
    const ks2 = await DeviceKeystore.open(engine, FAST);
    // Unseal succeeds (same passphrase) but the embedded identity is alice ≠ bob → import rejects
    // before persisting, and nothing is stored under bob.
    await expect(ks2.importRecoveryArtifact('bob', blob, 'shared pw')).rejects.toThrow();
    expect(await ks2.loadDevice('bob', 'shared pw')).toBeUndefined();
  });

  it('ensurePool mints a one-time pool to target — distinct, usable, same identity', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('alice', 'pw');

    const pool = await ks.ensurePool(device, 'pw', 3);
    expect(pool).toHaveLength(3);
    // each member shares the device's STABLE signature identity but is a DISTINCT one-time KeyPackage
    expect(pool.every((m) => deviceIdentity(m) === deviceIdentity(device))).toBe(true);
    expect(new Set(pool.map((m) => serializeKeyPackage(m.publicPackage))).size).toBe(3);
    // a pool member can join a group (its private was retained)
    const inviter = await engine.generateDeviceKeys('inviter');
    const conv = await engine.createConversation('r', inviter);
    const invite = await conv.addMember(pool[0]!.publicPackage);
    const joined = await engine.joinConversation(pool[0]!, invite);
    expect(await joined.decrypt(await conv.encrypt('hi'))).toBe('hi');
  });

  it('ensurePool is idempotent once full and persists across reopen', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('alice', 'pw');
    const first = (await ks.ensurePool(device, 'pw', 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    const again = (await ks.ensurePool(device, 'pw', 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(again).toEqual(first); // no re-mint when already at target

    const reopened = await DeviceKeystore.open(engine, FAST);
    const dev2 = await reopened.loadDevice('alice', 'pw');
    if (!dev2) throw new Error('expected a persisted device');
    const persisted = (await reopened.ensurePool(dev2, 'pw', 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect([...persisted].sort()).toEqual([...first].sort()); // pool survived reopen
  });

  it('clearDevice also clears the KeyPackage pool (fresh mints afterwards)', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('alice', 'pw');
    const before = new Set(
      (await ks.ensurePool(device, 'pw', 2)).map((m) => serializeKeyPackage(m.publicPackage)),
    );

    await ks.clearDevice();

    const device2 = await ks.getOrCreateDevice('alice', 'pw');
    const after = await ks.ensurePool(device2, 'pw', 2);
    // none of the new members is an old one → the pool store was genuinely cleared + re-minted
    expect(after.every((m) => !before.has(serializeKeyPackage(m.publicPackage)))).toBe(true);
  });

  it('clearDevice lets a profile recover from a stored device and re-import', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    await ks.getOrCreateDevice('alice', 'pw');
    const blob = await ks.exportRecoveryArtifact('alice', 'pw');
    if (!blob) throw new Error('expected a backup');

    await expect(ks.importRecoveryArtifact('alice', blob, 'pw')).rejects.toThrow(); // guarded
    await ks.clearDevice();
    const recovered = await ks.importRecoveryArtifact('alice', blob, 'pw'); // now allowed
    expect(await worksForMls(engine, recovered)).toBe('msg');
  });
});
