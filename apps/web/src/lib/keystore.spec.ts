import {
  MlsEngine,
  deviceIdentity,
  importUnlockKey,
  serializeKeyPackage,
  type DeviceKeys,
} from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { DeviceKeystore, GroupStateConflict, type StoredMessage } from './keystore';

const msg = (
  id: string,
  content: string,
  ts: string,
  senderId = 'peer',
  status = 'read',
): StoredMessage => ({ id, senderId, content, timestamp: ts, status });

/** A deterministic unlock key (stands in for a passkey-PRF output). Distinct `fill` → distinct key. */
function unlockKey(fill = 1): Promise<CryptoKey> {
  return importUnlockKey(new Uint8Array(32).fill(fill));
}

/** Prove a DeviceKeys works for MLS by exchanging a message; returns the decrypted text. */
async function worksForMls(engine: MlsEngine, keys: DeviceKeys): Promise<string> {
  const conv = await engine.createConversation('room', keys);
  const bob = await engine.generateDeviceKeys('bob');
  const invite = await conv.addMember(bob.publicPackage);
  const bobConv = await engine.joinConversation(bob, invite);
  return bobConv.decrypt(await conv.encrypt('msg'));
}

describe('DeviceKeystore — sealed at rest under the passkey-PRF unlock key', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory(); // fresh IndexedDB per test
  });

  it('generates, seals, persists, and unseals a working device with the unlock key', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    await ks.getOrCreateDevice('alice', key);
    await ks.getOrCreateDevice('alice', key); // idempotent — same sealed device

    const reopened = await DeviceKeystore.open(engine);
    const loaded = await reopened.loadDevice('alice', key);
    if (!loaded) throw new Error('expected a persisted device');
    expect(await worksForMls(engine, loaded)).toBe('msg');
  });

  it('hasDevice reflects whether a sealed device is stored (no unlock)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    expect(await ks.hasDevice()).toBe(false);
    await ks.getOrCreateDevice('alice', key);
    expect(await ks.hasDevice()).toBe(true);
    await ks.clearDevice();
    expect(await ks.hasDevice()).toBe(false);
  });

  it('rejects a wrong unlock key (sealed at rest)', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine);
    await ks.getOrCreateDevice('alice', await unlockKey(1));
    await expect(ks.loadDevice('alice', await unlockKey(2))).rejects.toThrow();
  });

  it('rejects a different identity on the same profile', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    await ks.getOrCreateDevice('alice', key);
    await expect(ks.getOrCreateDevice('bob', key)).rejects.toThrow();
    await expect(ks.loadDevice('bob', key)).rejects.toThrow();
  });

  it('is race-safe: concurrent first-runs converge on one device', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const [a, b] = await Promise.all([
      ks.getOrCreateDevice('alice', key),
      ks.getOrCreateDevice('alice', key),
    ]);
    expect(await worksForMls(engine, a)).toBe('msg');
    expect(await worksForMls(engine, b)).toBe('msg');
    expect(await ks.loadDevice('alice', key)).toBeDefined();
  });

  it('wipes every secret-bearing store on upgrade from a pre-PRF version (no stale unseal)', async () => {
    const engine = await MlsEngine.create();
    // Simulate a pre-PRF (v6) DB holding a device record sealed under the OLD scheme.
    const v6 = await openDB('argus-keystore', 6, {
      upgrade(db) {
        for (const name of ['device', 'key-package-pool', 'group-state', 'message-log', 'meta']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      },
    });
    await v6.put('device', { identity: 'alice', sealed: { v: 1, kdf: 'argon2id' } }, 'self');
    v6.close();

    // Opening at the PRF schema (v7) must wipe the old record, not misread it under the new key.
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    expect(await ks.loadDevice('alice', key)).toBeUndefined(); // old record gone
    const fresh = await ks.getOrCreateDevice('alice', key); // a fresh PRF-sealed device works
    expect(await worksForMls(engine, fresh)).toBe('msg');
  });

  it('ensurePool mints a one-time pool to target — distinct, usable, same identity', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);

    const pool = await ks.ensurePool(device, key, 3);
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
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const first = (await ks.ensurePool(device, key, 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    const again = (await ks.ensurePool(device, key, 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(again).toEqual(first); // no re-mint when already at target

    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const persisted = (await reopened.ensurePool(dev2, key, 3)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect([...persisted].sort()).toEqual([...first].sort()); // pool survived reopen
  });

  it('ensurePool is race-safe: concurrent provisions converge on one persisted pool', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);

    // Two tabs unlocking at once must NOT each publish a distinct pool (the losing one's privates would
    // be dropped while its packages stay claimable). The CAS makes both converge on the persisted pool.
    const [a, b] = await Promise.all([
      ks.ensurePool(device, key, 3),
      ks.ensurePool(device, key, 3),
    ]);
    const sa = a.map((m) => serializeKeyPackage(m.publicPackage)).sort();
    const sb = b.map((m) => serializeKeyPackage(m.publicPackage)).sort();
    expect(sa).toEqual(sb); // same pool returned to both callers

    // ...and it is exactly the pool actually persisted (a fresh reopen reads the same set).
    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const stored = (await reopened.ensurePool(dev2, key, 3))
      .map((m) => serializeKeyPackage(m.publicPackage))
      .sort();
    expect(stored).toEqual(sa);
  });

  it('removePoolMember drops exactly the consumed member and persists the removal', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const pool = await ks.ensurePool(device, key, 3);
    const removed = serializeKeyPackage(pool[0]!.publicPackage);

    await ks.removePoolMember(device, key, removed);

    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const left = (await reopened.ensurePool(dev2, key, 1)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(left).toHaveLength(2); // 3 − 1, and ensurePool(target 1) doesn't re-mint
    expect(left).not.toContain(removed);
  });

  it('removePoolMember is idempotent: removing an absent or already-removed member is a no-op', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const before = (await ks.ensurePool(device, key, 2)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );

    await ks.removePoolMember(device, key, 'not-a-member-keypackage'); // absent → no-op
    await ks.removePoolMember(device, key, before[0]!); // remove once
    await ks.removePoolMember(device, key, before[0]!); // removing again → no-op

    const after = (await ks.ensurePool(device, key, 1)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(after).toEqual([before[1]]); // exactly the one survivor
  });

  it('removePoolMember is final: a consumed private is never resurrected by a later replenish (FS)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const removed = serializeKeyPackage((await ks.ensurePool(device, key, 2))[0]!.publicPackage);

    await ks.removePoolMember(device, key, removed);
    // Replenish back to target: the gap is filled by a FRESH mint, never the dropped member.
    const refilled = (await ks.ensurePool(device, key, 2)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(refilled).toHaveLength(2);
    expect(refilled).not.toContain(removed); // the consumed one-time key never comes back
  });

  it('removePoolMember is race-safe against a concurrent replenish (the removed member stays gone)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const removed = serializeKeyPackage((await ks.ensurePool(device, key, 3))[0]!.publicPackage);

    // A prune racing a replenish must never let the consumed member survive (CAS + re-apply on lost race).
    await Promise.all([ks.removePoolMember(device, key, removed), ks.ensurePool(device, key, 3)]);

    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const final = (await reopened.ensurePool(dev2, key, 1)).map((m) =>
      serializeKeyPackage(m.publicPackage),
    );
    expect(final).not.toContain(removed);
  });

  it('clearDevice also clears the KeyPackage pool (fresh mints afterwards)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const before = new Set(
      (await ks.ensurePool(device, key, 2)).map((m) => serializeKeyPackage(m.publicPackage)),
    );

    await ks.clearDevice();

    const device2 = await ks.getOrCreateDevice('alice', key);
    const after = await ks.ensurePool(device2, key, 2);
    // none of the new members is an old one → the pool store was genuinely cleared + re-minted
    expect(after.every((m) => !before.has(serializeKeyPackage(m.publicPackage)))).toBe(true);
  });

  it('saveConversationState + loadConversations round-trips a usable group across reopen', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const peer = await engine.generateDeviceKeys('peer');
    const conv = await engine.createConversation('conv-1', device);
    const peerConv = await engine.joinConversation(peer, await conv.addMember(peer.publicPackage));
    expect(await peerConv.decrypt(await conv.encrypt('hello'))).toBe('hello'); // advance the ratchet

    await ks.saveConversationState(device, 'conv-1', conv, key);

    // Reopen the keystore (as on a reload), reload the device, rehydrate the conversations.
    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const restored = (await reopened.loadConversations(dev2, key)).get('conv-1');
    if (!restored) throw new Error('expected a restored conversation');
    // The restored group continues the SAME ratchet (the peer decrypts its next message in order).
    expect(await peerConv.decrypt(await restored.encrypt('after reload'))).toBe('after reload');
  });

  it('saveConversationState is ordered with the ratchet under concurrency (no rollback)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const peer = await engine.generateDeviceKeys('peer');
    const conv = await engine.createConversation('conv-1', device);
    const peerConv = await engine.joinConversation(peer, await conv.addMember(peer.publicPackage));

    // Fire several ratchet-advancing encrypts, each followed by a save, WITHOUT awaiting between them — so
    // the saves race. persistVia runs seal+put INSIDE the op mutex, so each save's snapshot is taken in op
    // order and the newest one is written last. If seal/put ran outside the mutex an older snapshot could
    // land after a newer one and overwrite it — an MLS rollback.
    const ciphertexts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        (async () => {
          const ct = await conv.encrypt(`m${i}`);
          await ks.saveConversationState(device, 'conv-1', conv, key);
          return ct;
        })(),
      ),
    );

    // The peer consumes every message in send order (the mutex serialized the encrypts in call order).
    for (const ct of ciphertexts) await peerConv.decrypt(ct);

    // Reload: the restored state must be the NEWEST, so its next send is a generation the peer has not seen.
    // A rolled-back save would replay an already-consumed generation and the peer's decrypt would throw.
    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const restored = (await reopened.loadConversations(dev2, key)).get('conv-1');
    if (!restored) throw new Error('expected a restored conversation');
    expect(await peerConv.decrypt(await restored.encrypt('after'))).toBe('after');
  });

  it('saveConversationState rejects a stale cross-instance write (no durable rollback)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ksA = await DeviceKeystore.open(engine);
    const device = await ksA.getOrCreateDevice('alice', key);
    const peer = await engine.generateDeviceKeys('peer');
    const conv = await engine.createConversation('conv-1', device);
    const peerConv = await engine.joinConversation(peer, await conv.addMember(peer.publicPackage));
    expect(await peerConv.decrypt(await conv.encrypt('hello'))).toBe('hello');
    await ksA.saveConversationState(device, 'conv-1', conv, key); // store version 0

    // A SECOND keystore over the same IndexedDB rehydrates its OWN instance (a second tab / double unlock):
    // independent op queue, so persistVia can't order it against instance A. It loads at version 0.
    const ksB = await DeviceKeystore.open(engine);
    const devB = await ksB.loadDevice('alice', key);
    if (!devB) throw new Error('expected a persisted device');
    const convB = (await ksB.loadConversations(devB, key)).get('conv-1');
    if (!convB) throw new Error('expected a restored conversation');

    // Instance A advances + saves again → store version 1. B's CAS base (0) is now stale.
    await peerConv.decrypt(await conv.encrypt('from A'));
    await ksA.saveConversationState(device, 'conv-1', conv, key); // store version 1

    // B advances its OWN (divergent) state and tries to save on the stale base → rejected, NOT applied.
    await convB.encrypt('from B');
    await expect(ksB.saveConversationState(devB, 'conv-1', convB, key)).rejects.toBeInstanceOf(
      GroupStateConflict,
    );

    // The durable state is still A's newest (no rollback): a fresh reload continues A's ratchet — its next
    // send is a generation the peer has not consumed.
    const ksC = await DeviceKeystore.open(engine);
    const devC = await ksC.loadDevice('alice', key);
    if (!devC) throw new Error('expected a persisted device');
    const convC = (await ksC.loadConversations(devC, key)).get('conv-1');
    if (!convC) throw new Error('expected a restored conversation');
    expect(await peerConv.decrypt(await convC.encrypt('after'))).toBe('after');
  });

  it('loadConversations skips a group bound to a different device signature key', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const peer = await engine.generateDeviceKeys('peer');
    const conv = await engine.createConversation('conv-1', device);
    await engine.joinConversation(peer, await conv.addMember(peer.publicPackage));
    await ks.saveConversationState(device, 'conv-1', conv, key);

    // A different device (same identity string, different signature key) must NOT load it.
    const other = await engine.generateDeviceKeys('alice');
    expect((await ks.loadConversations(other, key)).size).toBe(0);
  });

  it('deleteConversationState removes a persisted conversation; clearDevice clears them all', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    const peer = await engine.generateDeviceKeys('peer');
    const a = await engine.createConversation('a', device);
    const b = await engine.createConversation('b', device);
    await a.addMember(peer.publicPackage);
    await b.addMember(peer.publicPackage);
    await ks.saveConversationState(device, 'a', a, key);
    await ks.saveConversationState(device, 'b', b, key);

    await ks.deleteConversationState('a');
    expect([...(await ks.loadConversations(device, key)).keys()]).toEqual(['b']);

    await ks.clearDevice();
    const device2 = await ks.getOrCreateDevice('alice', key);
    expect((await ks.loadConversations(device2, key)).size).toBe(0);
  });

  it('message log: append → reload → history round-trips under the same unlock key', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    await ks.appendMessages(device, 'c1', key, [
      msg('m2', 'there', '2026-01-01T00:00:02.000Z'),
      msg('m1', 'hi', '2026-01-01T00:00:01.000Z'), // out of order — load sorts by timestamp
    ]);

    const reopened = await DeviceKeystore.open(engine);
    const dev2 = await reopened.loadDevice('alice', key);
    if (!dev2) throw new Error('expected a persisted device');
    const log = await reopened.loadMessageLog(dev2, 'c1', key);
    expect(log.map((m) => m.content)).toEqual(['hi', 'there']);
  });

  it('message log: upserts by id (a later status update replaces the entry)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    await ks.appendMessages(device, 'c1', key, [msg('m1', 'hello', 't', 'me', 'sending')]);
    await ks.appendMessages(device, 'c1', key, [msg('m1', 'hello', 't', 'me', 'read')]);
    const log = await ks.loadMessageLog(device, 'c1', key);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('read');
  });

  it('message log: fails closed on a wrong unlock key (empty history, no throw)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey(1);
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    await ks.appendMessages(device, 'c1', key, [msg('m1', 'secret', 't')]);
    // A wrong key → GCM auth fails → treated as no history.
    expect(await ks.loadMessageLog(device, 'c1', await unlockKey(2))).toEqual([]);
  });

  it('message log: skips a log bound to a different device; loadAll + clearDevice', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ks = await DeviceKeystore.open(engine);
    const device = await ks.getOrCreateDevice('alice', key);
    await ks.appendMessages(device, 'a', key, [msg('m1', 'in a', 't')]);
    await ks.appendMessages(device, 'b', key, [msg('m2', 'in b', 't')]);
    expect([...(await ks.loadAllMessageLogs(device, key)).keys()].sort()).toEqual(['a', 'b']);

    // A different device (same identity string, different signature key) sees nothing.
    const other = await engine.generateDeviceKeys('alice');
    expect((await ks.loadAllMessageLogs(other, key)).size).toBe(0);

    await ks.clearDevice();
    const device2 = await ks.getOrCreateDevice('alice', key);
    expect((await ks.loadAllMessageLogs(device2, key)).size).toBe(0);
  });

  it('message log: concurrent cross-tab appends BOTH survive (CAS retry, no clobber)', async () => {
    const engine = await MlsEngine.create();
    const key = await unlockKey();
    const ksA = await DeviceKeystore.open(engine);
    const device = await ksA.getOrCreateDevice('alice', key);

    // A second keystore over the SAME IndexedDB = a second tab (its own in-memory appendChains).
    const ksB = await DeviceKeystore.open(engine);
    const devB = await ksB.loadDevice('alice', key);
    if (!devB) throw new Error('expected a persisted device');

    // Both tabs append to the same conversation concurrently (e.g. A sends an echo while B persists a push).
    await Promise.all([
      ksA.appendMessages(device, 'c1', key, [
        msg('a1', 'from A', '2026-01-01T00:00:01.000Z', 'me'),
      ]),
      ksB.appendMessages(devB, 'c1', key, [msg('b1', 'from B', '2026-01-01T00:00:02.000Z')]),
    ]);

    // Neither entry is clobbered — a fresh reader sees both.
    const ksC = await DeviceKeystore.open(engine);
    const devC = await ksC.loadDevice('alice', key);
    if (!devC) throw new Error('expected a persisted device');
    const log = await ksC.loadMessageLog(devC, 'c1', key);
    expect(log.map((m) => m.id).sort()).toEqual(['a1', 'b1']);
  });
});
