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

  it('skips a stranded welcome (no matching pool key) and continues the drain', async () => {
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

    // The stranded welcome is skipped (never consumed/pruned/surfaced); the good one is fully processed.
    expect(joined.map((j) => j.conversationId)).toEqual(['c-good']);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith('w-good', 'dev', expect.any(String));
    expect(prune).toHaveBeenCalledTimes(1);
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
});
