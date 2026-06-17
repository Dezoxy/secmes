import { MlsEngine, deserializeInvite, importUnlockKey, serializeInvite } from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the directory/server calls; the crypto (join + proofs) and the keystore (real IndexedDB seal) are real.
vi.mock('./api', () => ({
  listWelcomes: vi.fn(),
  fetchWelcomeMaterial: vi.fn(),
  consumeWelcome: vi.fn(),
}));
import { consumeWelcome, fetchWelcomeMaterial, listWelcomes } from './api';
import { joinPendingConversations, type JoinedConversation } from './join';
import { DeviceKeystore } from './keystore';

const list = vi.mocked(listWelcomes);
const fetchMaterial = vi.mocked(fetchWelcomeMaterial);
const consume = vi.mocked(consumeWelcome);

/** The non-crypto deps every call needs: a fresh sealed keystore + the session unlock key. */
async function persistenceDeps(
  engine: MlsEngine,
): Promise<{ keystore: DeviceKeystore; sessionKey: CryptoKey }> {
  const keystore = await DeviceKeystore.open(engine);
  return { keystore, sessionKey: await importUnlockKey(new Uint8Array(32).fill(1)) };
}

describe('joinPendingConversations', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory(); // fresh IndexedDB per test (sealed group-state store)
    list.mockReset();
    fetchMaterial.mockReset();
    consume.mockReset();
    consume.mockResolvedValue(undefined);
  });

  it('joins a pending welcome, persists it, surfaces it, and consumes the Welcome', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob, await engine.mintKeyPackage(bob)];
    const target = bobPool[1]!; // the directory sealed the welcome to THIS pool member
    const { keystore, sessionKey } = await persistenceDeps(engine);

    const aliceConv = await engine.createConversation('grp', alice);
    const material = serializeInvite(await aliceConv.addMember(target.publicPackage));

    list.mockResolvedValue([
      { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(material);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // fetch carries a base64url proof; the joined group really decrypts a message from the inviter.
    expect(fetchMaterial).toHaveBeenCalledWith(
      'w1',
      'dev',
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.conversationId).toBe('c1');
    expect(await joined[0]!.conversation.decrypt(await aliceConv.encrypt('hi'))).toBe('hi');
    // The group state is now PERSISTED (5A), so a reload recovers it without re-joining...
    expect((await keystore.loadConversations(bob, sessionKey)).has('c1')).toBe(true);
    // ...and the Welcome is consumed (forward secrecy — the sealed join material is no longer needed).
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('clears a stranded welcome and joins+consumes the good one', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob];
    const stranded = await engine.mintKeyPackage(bob); // a key NOT retained in bob's pool
    const { keystore, sessionKey } = await persistenceDeps(engine);

    const strandedMaterial = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(stranded.publicPackage),
    );
    const goodMaterial = serializeInvite(
      await (await engine.createConversation('g2', alice)).addMember(bob.publicPackage),
    );

    list.mockResolvedValue([
      { id: 'w-stranded', conversationId: 'c-stranded', senderUserId: 'peer-user', createdAt: 't' },
      { id: 'w-good', conversationId: 'c-good', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockImplementation((id) =>
      Promise.resolve(id === 'w-stranded' ? strandedMaterial : goodMaterial),
    );
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // The good one joins; BOTH welcomes are consumed — the stranded one cleared, the good one after its
    // durable save.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).toHaveBeenCalledWith('w-stranded', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledWith('w-good', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('leaves a transient fetch failure pending (does not consume it) and joins the rest', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const { keystore, sessionKey } = await persistenceDeps(engine);

    const goodMaterial = serializeInvite(
      await (await engine.createConversation('g', alice)).addMember(bob.publicPackage),
    );
    list.mockResolvedValue([
      { id: 'w-flaky', conversationId: 'c-flaky', senderUserId: 'peer-user', createdAt: 't' },
      { id: 'w-good', conversationId: 'c-good', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockImplementation((id) =>
      id === 'w-flaky' ? Promise.reject(new Error('network')) : Promise.resolve(goodMaterial),
    );
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: [bob],
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // The flaky one is left pending (NOT consumed → retried next connect); the good one joins + consumes.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('w-good', 'dev', expect.any(String));
  });

  it('drains across multiple list pages, re-listing until the queue is empty', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob), await engine.mintKeyPackage(bob)];
    const { keystore, sessionKey } = await persistenceDeps(engine);
    const seal = async (
      m: (typeof pool)[number],
      g: string,
    ): Promise<{ welcome: string; ratchetTree: string }> =>
      serializeInvite(await (await engine.createConversation(g, alice)).addMember(m.publicPackage));
    const mat: Record<string, { welcome: string; ratchetTree: string }> = {
      w1: await seal(pool[0]!, 'g1'),
      w2: await seal(pool[1]!, 'g2'),
      w3: await seal(pool[2]!, 'g3'),
    };

    // Newer Welcomes appear across re-lists (page 1 → page 2 → empty).
    list
      .mockResolvedValueOnce([
        { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
        { id: 'w2', conversationId: 'c2', senderUserId: 'peer-user', createdAt: 't' },
      ])
      .mockResolvedValueOnce([
        { id: 'w3', conversationId: 'c3', senderUserId: 'peer-user', createdAt: 't' },
      ])
      .mockResolvedValue([]);
    fetchMaterial.mockImplementation((id) => Promise.resolve(mat[id]!));
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // All three pages join (the drain re-lists beyond the first page); each is consumed after its save.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1', 'c2', 'c3']);
    expect(consume).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never reuses a spent one-time private: a second welcome sealed to the same package is cleared (FS)', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob)];
    const target = pool[1]!;
    const { keystore, sessionKey } = await persistenceDeps(engine);
    // TWO welcomes both sealed to the SAME pool member (a deliver duplicate / replay / reused claim).
    const w1mat = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(target.publicPackage),
    );
    const w2mat = serializeInvite(
      await (await engine.createConversation('g2', alice)).addMember(target.publicPackage),
    );

    list
      .mockResolvedValueOnce([
        { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
        { id: 'w2', conversationId: 'c2', senderUserId: 'peer-user', createdAt: 't' },
      ])
      .mockResolvedValue([]);
    fetchMaterial.mockImplementation((id) => Promise.resolve(id === 'w1' ? w1mat : w2mat));
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // Only the FIRST joins (+ consumes); the second can't reuse the now-spent private (NoMatchingPoolMember)
    // → it is cleared (consumed without joining). Both ids are consumed, neither survives.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']);
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledWith('w2', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('onSpent lets a caller prune its session pool so a LATER drain never reuses a spent private (cross-call FS)', async () => {
    // The P1 from PR #159: `pool` is set once at unlock and never pruned; each drain prunes only the sealed
    // keystore + its in-call workingPool. A second drain (a live `welcome` nudge) re-passing the original
    // pool would resurrect an already-spent one-time private and re-open a replayed Welcome. The fix: the
    // caller keeps a SESSION pool pruned via onSpent across drains. This test models exactly that pattern.
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const kpA = await engine.mintKeyPackage(bob);
    const sessionPool = [bob, kpA]; // the hook's long-lived working pool — NOT re-seeded per drain
    const onSpent = (member: (typeof sessionPool)[number]): void => {
      const at = sessionPool.indexOf(member);
      if (at !== -1) sessionPool.splice(at, 1);
    };
    const { keystore, sessionKey } = await persistenceDeps(engine);

    // Two welcomes BOTH sealed to kpA, delivered in SEPARATE drains (connect, then a replayed live nudge).
    const w1mat = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(kpA.publicPackage),
    );
    const w2mat = serializeInvite(
      await (await engine.createConversation('g2', alice)).addMember(kpA.publicPackage),
    );
    const joined: JoinedConversation[] = [];
    list.mockResolvedValue([]); // default: every re-list page is empty (terminates each drain's loop)

    // Drain 1 (connect): joins w1, spends kpA → onSpent prunes it from the session pool.
    list.mockResolvedValueOnce([
      { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(w1mat);
    await joinPendingConversations({
      device: bob,
      pool: sessionPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onSpent,
      onJoined: (j) => joined.push(j),
    });
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']);
    expect(sessionPool).toHaveLength(1); // kpA pruned across the call boundary; only `bob` remains

    // Drain 2 (a live `welcome` nudge) replays a Welcome sealed to the now-spent kpA.
    list.mockResolvedValueOnce([
      { id: 'w2', conversationId: 'c2', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(w2mat);
    await joinPendingConversations({
      device: bob,
      pool: sessionPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onSpent,
      onJoined: (j) => joined.push(j),
    });

    // The replay must NOT rejoin (kpA is gone from the session pool) — it's cleared (NoMatchingPoolMember →
    // consumed without joining). Pre-fix this returned c2 too, reusing the spent one-time private.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']);
    expect(consume).toHaveBeenCalledWith('w2', 'dev', expect.any(String));
  });

  it('does NOT prune the session pool when the durable save fails, so a same-session retry re-joins', async () => {
    // The follow-up P1: onSpent must fire only once the join is DURABLE. If saveConversationState throws
    // (e.g. an IndexedDB quota/transient failure, not just a cross-tab conflict), the Welcome is left pending
    // for retry — pruning the session pool then would strand it (a later drain hits NoMatchingPoolMember and
    // clears the only join material). So the prune is deferred past the save.
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const kpA = await engine.mintKeyPackage(bob);
    const sessionPool = [bob, kpA];
    const onSpent = (member: (typeof sessionPool)[number]): void => {
      const at = sessionPool.indexOf(member);
      if (at !== -1) sessionPool.splice(at, 1);
    };
    const { keystore, sessionKey } = await persistenceDeps(engine);
    const material = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(kpA.publicPackage),
    );
    const joined: JoinedConversation[] = [];
    list.mockResolvedValue([]); // default: every re-list page is empty

    // Drain 1: the durable save FAILS → the Welcome is left pending and the session pool is NOT pruned.
    const saveSpy = vi
      .spyOn(keystore, 'saveConversationState')
      .mockRejectedValueOnce(new Error('quota exceeded'));
    list.mockResolvedValueOnce([
      { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(material);
    await joinPendingConversations({
      device: bob,
      pool: sessionPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onSpent,
      onJoined: (j) => joined.push(j),
    });
    expect(joined).toHaveLength(0); // nothing surfaced (save threw)
    expect(sessionPool).toHaveLength(2); // kpA STILL present — the private was not pruned
    expect(consume).not.toHaveBeenCalled(); // Welcome left pending, not consumed
    saveSpy.mockRestore();

    // Drain 2 (retry): the SAME still-pending Welcome saves successfully → re-joins with the retained kpA.
    list.mockResolvedValueOnce([
      { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(material);
    await joinPendingConversations({
      device: bob,
      pool: sessionPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onSpent,
      onJoined: (j) => joined.push(j),
    });
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']); // recovered, not stranded
    expect(sessionPool).toHaveLength(1); // NOW kpA is pruned — the join is durable
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.any(String)); // and the Welcome consumed
  });

  it('does not overwrite an already-persisted (advanced) conversation when its Welcome is replayed (no rollback)', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob, await engine.mintKeyPackage(bob)];
    const target = bobPool[1]!;
    const { keystore, sessionKey } = await persistenceDeps(engine);

    const aliceConv = await engine.createConversation('grp', alice);
    const material = serializeInvite(await aliceConv.addMember(target.publicPackage));

    // Simulate a PRIOR join whose consume+prune FAILED: join, ADVANCE the ratchet (receive a message),
    // persist the advanced state, and seed the keystore CAS base (as rehydrate-on-unlock would).
    const pre = await engine.joinConversationFromPool([...bobPool], deserializeInvite(material));
    const m1wire = await aliceConv.encrypt('m1');
    await pre.conversation.decrypt(m1wire); // advance bob's receive ratchet past alice's generation 0
    await keystore.saveConversationState(bob, 'c1', pre.conversation, sessionKey);
    await keystore.loadConversations(bob, sessionKey); // sets the CAS base to the persisted version

    // The SAME Welcome is still pending (consume failed before); the drain replays it.
    list.mockResolvedValue([
      { id: 'w1', conversationId: 'c1', senderUserId: 'peer-user', createdAt: 't' },
    ]);
    fetchMaterial.mockResolvedValue(material);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // It must NOT surface a duplicate and must NOT overwrite the advanced state...
    expect(joined).toHaveLength(0);
    // ...the persisted state is still the ADVANCED one — it already consumed alice's generation 0, so
    // re-decrypting m1 throws (a rolled-back fresh-join state would instead decrypt it). The rollback proof.
    const restored = (await keystore.loadConversations(bob, sessionKey)).get('c1')!;
    await expect(restored.decrypt(m1wire)).rejects.toThrow();
    // ...and the redundant Welcome was cleared.
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.any(String));
  });

  it('clears a stranded welcome blocking the cursorless page so a valid welcome behind it is reached', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const stranded = await engine.mintKeyPackage(bob); // NOT retained in bob's pool
    const pool = [bob]; // only `bob` is joinable
    const { keystore, sessionKey } = await persistenceDeps(engine);

    const strandedMat = serializeInvite(
      await (await engine.createConversation('gs', alice)).addMember(stranded.publicPackage),
    );
    const goodMat = serializeInvite(
      await (await engine.createConversation('gg', alice)).addMember(bob.publicPackage),
    );

    // Model the server's oldest-first, CURSORLESS list with page size 1; consume removes from the queue.
    const queue = new Map([
      ['w-stranded', 'c-stranded'],
      ['w-good', 'c-good'],
    ]);
    list.mockImplementation(() =>
      Promise.resolve(
        [...queue.entries()].slice(0, 1).map(([id, conversationId]) => ({
          id,
          conversationId,
          senderUserId: 'peer-user',
          createdAt: 't',
        })),
      ),
    );
    fetchMaterial.mockImplementation((id) =>
      Promise.resolve(id === 'w-stranded' ? strandedMat : goodMat),
    );
    consume.mockImplementation((id) => {
      queue.delete(id);
      return Promise.resolve();
    });
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      keystore,
      sessionKey,
      onJoined: (j) => joined.push(j),
    });

    // w-stranded sat at the head and (without a cursor) would hide w-good behind it; clearing it lets the
    // drain reach + join w-good. Now that a joined Welcome is consumed too, the queue fully drains.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect([...queue.keys()]).toEqual([]);
  });
});
