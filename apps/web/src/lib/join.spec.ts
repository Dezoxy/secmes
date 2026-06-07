import { MlsEngine, serializeInvite } from '@argus/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the directory/server calls; the crypto (join + proofs) is real.
vi.mock('./api', () => ({
  listWelcomes: vi.fn(),
  fetchWelcomeMaterial: vi.fn(),
  consumeWelcome: vi.fn(),
}));
import { consumeWelcome, fetchWelcomeMaterial, listWelcomes } from './api';
import { joinPendingConversations, type JoinedConversation } from './join';

const list = vi.mocked(listWelcomes);
const fetchMaterial = vi.mocked(fetchWelcomeMaterial);
const consume = vi.mocked(consumeWelcome);

describe('joinPendingConversations', () => {
  beforeEach(() => {
    list.mockReset();
    fetchMaterial.mockReset();
    consume.mockReset();
    consume.mockResolvedValue(undefined);
  });

  it('joins a pending welcome and surfaces it — WITHOUT consuming it (kept as the reload anchor)', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob, await engine.mintKeyPackage(bob)];
    const target = bobPool[1]!; // the directory sealed the welcome to THIS pool member

    const aliceConv = await engine.createConversation('grp', alice);
    const material = serializeInvite(await aliceConv.addMember(target.publicPackage));

    list.mockResolvedValue([{ id: 'w1', conversationId: 'c1', createdAt: 't' }]);
    fetchMaterial.mockResolvedValue(material);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
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
    // The Welcome is NOT consumed (no durable group state until Slice 5 — keep it for reload recovery).
    expect(consume).not.toHaveBeenCalled();
  });

  it('clears a stranded welcome (consumes it without joining) and continues to join the good one', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob];
    const stranded = await engine.mintKeyPackage(bob); // a key NOT retained in bob's pool

    const strandedMaterial = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(stranded.publicPackage),
    );
    const goodMaterial = serializeInvite(
      await (await engine.createConversation('g2', alice)).addMember(bob.publicPackage),
    );

    list.mockResolvedValue([
      { id: 'w-stranded', conversationId: 'c-stranded', createdAt: 't' },
      { id: 'w-good', conversationId: 'c-good', createdAt: 't' },
    ]);
    fetchMaterial.mockImplementation((id) =>
      Promise.resolve(id === 'w-stranded' ? strandedMaterial : goodMaterial),
    );
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      onJoined: (j) => joined.push(j),
    });

    // The stranded welcome is CLEARED (consumed without joining); the good one is joined but NOT consumed.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('w-stranded', 'dev', expect.any(String));
  });

  it('leaves a transient fetch failure pending (does not clear it) and joins the rest', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');

    const goodMaterial = serializeInvite(
      await (await engine.createConversation('g', alice)).addMember(bob.publicPackage),
    );
    list.mockResolvedValue([
      { id: 'w-flaky', conversationId: 'c-flaky', createdAt: 't' },
      { id: 'w-good', conversationId: 'c-good', createdAt: 't' },
    ]);
    fetchMaterial.mockImplementation((id) =>
      id === 'w-flaky' ? Promise.reject(new Error('network')) : Promise.resolve(goodMaterial),
    );
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: [bob],
      deviceId: 'dev',
      onJoined: (j) => joined.push(j),
    });

    // The flaky one is left pending (NOT consumed → retried next connect); the good one still joins.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).not.toHaveBeenCalled();
  });

  it('drains across multiple list pages, re-listing until the queue is empty', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob), await engine.mintKeyPackage(bob)];
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
        { id: 'w1', conversationId: 'c1', createdAt: 't' },
        { id: 'w2', conversationId: 'c2', createdAt: 't' },
      ])
      .mockResolvedValueOnce([{ id: 'w3', conversationId: 'c3', createdAt: 't' }])
      .mockResolvedValue([]);
    fetchMaterial.mockImplementation((id) => Promise.resolve(mat[id]!));
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      onJoined: (j) => joined.push(j),
    });

    // All three pages are joined (the drain re-lists beyond the first page); none is consumed.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1', 'c2', 'c3']);
    expect(consume).not.toHaveBeenCalled();
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never reuses a spent one-time private: a second welcome sealed to the same package is cleared (FS)', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob)];
    const target = pool[1]!;
    // TWO welcomes both sealed to the SAME pool member (a deliver duplicate / replay / reused claim).
    const w1mat = serializeInvite(
      await (await engine.createConversation('g1', alice)).addMember(target.publicPackage),
    );
    const w2mat = serializeInvite(
      await (await engine.createConversation('g2', alice)).addMember(target.publicPackage),
    );

    list
      .mockResolvedValueOnce([
        { id: 'w1', conversationId: 'c1', createdAt: 't' },
        { id: 'w2', conversationId: 'c2', createdAt: 't' },
      ])
      .mockResolvedValue([]);
    fetchMaterial.mockImplementation((id) => Promise.resolve(id === 'w1' ? w1mat : w2mat));
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      onJoined: (j) => joined.push(j),
    });

    // Only the FIRST joins (kept pending); the second can't reuse the now-spent private (NoMatchingPoolMember)
    // → it is cleared (consumed without joining), never joined.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('w2', 'dev', expect.any(String));
  });

  it('clears a stranded welcome blocking the cursorless page so a valid welcome behind it is reached', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const stranded = await engine.mintKeyPackage(bob); // NOT retained in bob's pool
    const pool = [bob]; // only `bob` is joinable

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
        [...queue.entries()]
          .slice(0, 1)
          .map(([id, conversationId]) => ({ id, conversationId, createdAt: 't' })),
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
      onJoined: (j) => joined.push(j),
    });

    // w-stranded sat at the head and (without a cursor) would hide w-good behind it; clearing it lets the
    // drain reach + join w-good. The joined w-good stays pending (not consumed — the reload anchor).
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect([...queue.keys()]).toEqual(['w-good']);
  });
});
