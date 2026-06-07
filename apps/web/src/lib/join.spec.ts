import { MlsEngine, serializeInvite, serializeKeyPackage } from '@argus/crypto';
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
  });

  it('drains a pending welcome: fetch → join → consume → prune, then surfaces the joined group', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const bobPool = [bob, await engine.mintKeyPackage(bob)];
    const target = bobPool[1]!; // the directory sealed the welcome to THIS pool member

    const aliceConv = await engine.createConversation('grp', alice);
    const material = serializeInvite(await aliceConv.addMember(target.publicPackage));

    list.mockResolvedValue([{ id: 'w1', conversationId: 'c1', createdAt: 't' }]);
    fetchMaterial.mockResolvedValue(material);
    consume.mockResolvedValue(undefined);
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // fetch + consume carry a base64url proof; the matched pool member is pruned (forward secrecy).
    expect(fetchMaterial).toHaveBeenCalledWith(
      'w1',
      'dev',
      expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    );
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.stringMatching(/^[A-Za-z0-9_-]+$/));
    expect(prune).toHaveBeenCalledWith(serializeKeyPackage(target.publicPackage));
    // ordering: prune only AFTER consume.
    expect(consume.mock.invocationCallOrder[0]!).toBeLessThan(prune.mock.invocationCallOrder[0]!);
    // surfaced exactly the joined conversation, and its group really decrypts a message from the inviter.
    expect(joined).toHaveLength(1);
    expect(joined[0]!.conversationId).toBe('c1');
    expect(await joined[0]!.conversation.decrypt(await aliceConv.encrypt('hi'))).toBe('hi');
  });

  it('clears a stranded welcome (consumes it without joining) and continues the drain', async () => {
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
    consume.mockResolvedValue(undefined);
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: bobPool,
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // The stranded welcome is CLEARED (consumed without joining) so it can't block the queue; the good one
    // is joined+consumed+pruned.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith('w-stranded', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledWith('w-good', 'dev', expect.any(String));
    expect(prune).toHaveBeenCalledTimes(1); // only the joined welcome prunes its member
    expect(prune).toHaveBeenCalledWith(serializeKeyPackage(bob.publicPackage));
  });

  it('does not prune when consume fails — leaves the welcome for an idempotent retry', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');

    const material = serializeInvite(
      await (await engine.createConversation('g', alice)).addMember(bob.publicPackage),
    );
    list.mockResolvedValue([{ id: 'w1', conversationId: 'c1', createdAt: 't' }]);
    fetchMaterial.mockResolvedValue(material);
    consume.mockRejectedValue(new Error('network')); // consume fails after a successful join
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool: [bob],
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // consume threw → the welcome is NOT surfaced and the member is NOT pruned (its private is kept so the
    // next connect re-joins + re-consumes; never prune before a confirmed consume).
    expect(joined).toHaveLength(0);
    expect(prune).not.toHaveBeenCalled();
  });

  it('drains across multiple pages, re-listing until the welcome queue is empty', async () => {
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

    // Page 1 (full-ish) → page 2 → empty. Consumed welcomes drop off, so re-listing yields the next page.
    list
      .mockResolvedValueOnce([
        { id: 'w1', conversationId: 'c1', createdAt: 't' },
        { id: 'w2', conversationId: 'c2', createdAt: 't' },
      ])
      .mockResolvedValueOnce([{ id: 'w3', conversationId: 'c3', createdAt: 't' }])
      .mockResolvedValue([]);
    fetchMaterial.mockImplementation((id) => Promise.resolve(mat[id]!));
    consume.mockResolvedValue(undefined);
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // All three pages drained (not just the first), and we re-listed beyond the first page.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1', 'c2', 'c3']);
    expect(consume).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never reuses a spent one-time private: two welcomes sealed to the same package → second skipped (FS)', async () => {
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
    consume.mockResolvedValue(undefined);
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // Only the FIRST joins; the second can't reuse the now-spent private (NoMatchingPoolMember) → it is
    // cleared (consumed without joining), never joined or pruned.
    expect(joined.map((j) => j.conversationId)).toEqual(['c1']);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith('w1', 'dev', expect.any(String));
    expect(consume).toHaveBeenCalledWith('w2', 'dev', expect.any(String));
    expect(prune).toHaveBeenCalledTimes(1); // only w1 joined → only its member is pruned
    expect(prune).toHaveBeenCalledWith(serializeKeyPackage(target.publicPackage));
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
    const prune = vi.fn().mockResolvedValue(undefined);
    const joined: JoinedConversation[] = [];

    await joinPendingConversations({
      device: bob,
      pool,
      deviceId: 'dev',
      prunePoolMember: prune,
      onJoined: (j) => joined.push(j),
    });

    // w-stranded sat at the head and (without a cursor) would hide w-good behind it; clearing it lets the
    // drain reach + join w-good. Both leave the queue.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(queue.size).toBe(0);
  });
});
