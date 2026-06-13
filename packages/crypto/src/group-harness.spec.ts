import { describe, expect, it } from 'vitest';

import { MlsEngine, type Conversation, type StagedCommit } from './index.js';

// B1 — group chat harness. Each test proves a specific property of the staged-commit API and
// multi-party MLS: 3-party messaging, remove semantics, 409 epoch-race rebase, and pending-adopt-on-reload.
// The mock server stores opaque bytes and never inspects them (crypto-blind invariant #1).

/** Trivial in-memory epoch-lock server: first POST to an epoch wins; subsequent attempts get 409. */
class MockEpochServer {
  private readonly slots = new Map<number, Uint8Array>();
  private readonly commitList: Array<{ epoch: number; wire: Uint8Array }> = [];

  postCommit(epoch: number, wire: Uint8Array): { ok: true } | { ok: false; currentEpoch: number } {
    if (this.slots.has(epoch)) {
      const currentEpoch = Math.max(...this.slots.keys());
      return { ok: false, currentEpoch };
    }
    this.slots.set(epoch, wire);
    this.commitList.push({ epoch, wire });
    return { ok: true };
  }

  getCommitsSince(afterEpoch: number): Array<{ epoch: number; wire: Uint8Array }> {
    return this.commitList.filter((c) => c.epoch > afterEpoch).sort((a, b) => a.epoch - b.epoch);
  }
}

const noop: (snapshot: Uint8Array) => Promise<void> = async () => {};

/** Submit a staged commit to the mock server and apply it on success. Throws on 409. */
async function submit(
  conv: Conversation,
  opts: Parameters<Conversation['stageMembershipCommit']>[0],
  server: MockEpochServer,
): Promise<StagedCommit> {
  const staged = await conv.stageMembershipCommit(opts);
  const res = server.postCommit(staged.epoch, staged.commit);
  if (!res.ok) {
    conv.discardStaged(staged);
    throw new Error(`epoch race at epoch ${staged.epoch}; server is at ${res.currentEpoch}`);
  }
  await conv.applyStaged(staged);
  return staged;
}

describe('B1 — MLS group chat harness', () => {
  it('3-device group: Alice adds Bob then Carol; all three can send and receive at epoch 2', async () => {
    const engine = await MlsEngine.create();
    const server = new MockEpochServer();

    const aKeys = await engine.generateDeviceKeys('alice');
    const bKeys = await engine.generateDeviceKeys('bob');
    const cKeys = await engine.generateDeviceKeys('carol');

    const alice = await engine.createConversation('conv', aKeys);
    expect(alice.epoch).toBe(0);

    // Epoch 0 → 1: Alice adds Bob.
    const stagedB = await submit(alice, { add: [bKeys.publicPackage] }, server);
    expect(alice.epoch).toBe(1);
    expect(stagedB.invite).toBeDefined();
    const bob = await engine.joinConversation(bKeys, stagedB.invite!);
    expect(bob.epoch).toBe(1);

    // Epoch 1 → 2: Alice adds Carol.
    const stagedC = await submit(alice, { add: [cKeys.publicPackage] }, server);
    expect(alice.epoch).toBe(2);
    expect(stagedC.invite).toBeDefined();

    // Bob must drain the epoch-1→2 commit before he can read Carol's messages.
    // Bob is at epoch 1; the commit that advances to 2 was posted at epoch=1, so pass epoch-1=0.
    const pendingCommits = server.getCommitsSince(bob.epoch - 1);
    for (const { wire } of pendingCommits) {
      await bob.processCommit(wire, noop);
    }
    expect(bob.epoch).toBe(2);

    // Carol joins directly at epoch 2.
    const carol = await engine.joinConversation(cKeys, stagedC.invite!);
    expect(carol.epoch).toBe(2);

    // Alice → Bob and Carol.
    const aliceWire = await alice.encrypt('hello everyone');
    expect(await bob.decrypt(aliceWire)).toBe('hello everyone');
    expect(await carol.decrypt(aliceWire)).toBe('hello everyone');

    // Bob → Alice and Carol.
    const bobWire = await bob.encrypt('hi from bob');
    expect(await alice.decrypt(bobWire)).toBe('hi from bob');
    expect(await carol.decrypt(bobWire)).toBe('hi from bob');

    // Carol → Alice and Bob.
    const carolWire = await carol.encrypt('carol here');
    expect(await alice.decrypt(carolWire)).toBe('carol here');
    expect(await bob.decrypt(carolWire)).toBe('carol here');
  });

  it('remove: removed member cannot decrypt messages sent after removal epoch', async () => {
    const engine = await MlsEngine.create();
    const server = new MockEpochServer();

    const aKeys = await engine.generateDeviceKeys('alice');
    const bKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv', aKeys);

    const stagedAdd = await submit(alice, { add: [bKeys.publicPackage] }, server);
    const bob = await engine.joinConversation(bKeys, stagedAdd.invite!);
    expect(alice.epoch).toBe(1);
    expect(bob.epoch).toBe(1);

    // Alice removes Bob.
    const members = alice.members();
    const bobMember = members.find((m) => m.identity === 'bob');
    expect(bobMember).toBeDefined();
    await submit(alice, { removeLeafIndices: [bobMember!.leafIndex] }, server);
    expect(alice.epoch).toBe(2);

    // Bob is still at epoch 1. A message encrypted by Alice at epoch 2 must NOT decrypt for Bob.
    const afterRemoval = await alice.encrypt('secret after removal');
    await expect(bob.decrypt(afterRemoval)).rejects.toThrow();
  });

  it('409 epoch race: two members try to add at the same epoch; loser drains and rebases', async () => {
    const engine = await MlsEngine.create();
    const server = new MockEpochServer();

    const aKeys = await engine.generateDeviceKeys('alice');
    const bKeys = await engine.generateDeviceKeys('bob');
    const cKeys = await engine.generateDeviceKeys('carol');
    const dKeys = await engine.generateDeviceKeys('dave');
    const alice = await engine.createConversation('conv', aKeys);

    // Both Alice and Bob are at epoch 1 (after Alice adds Bob).
    const stagedAdd = await submit(alice, { add: [bKeys.publicPackage] }, server);
    const bob = await engine.joinConversation(bKeys, stagedAdd.invite!);
    expect(alice.epoch).toBe(1);
    expect(bob.epoch).toBe(1);

    // Both stage a commit at epoch 1 — Alice adds Carol, Bob adds Dave simultaneously.
    const stagedAlice = await alice.stageMembershipCommit({ add: [cKeys.publicPackage] });
    const stagedBob = await bob.stageMembershipCommit({ add: [dKeys.publicPackage] });
    expect(stagedAlice.epoch).toBe(1);
    expect(stagedBob.epoch).toBe(1);

    // Alice wins slot 1.
    const rA = server.postCommit(stagedAlice.epoch, stagedAlice.commit);
    expect(rA.ok).toBe(true);
    await alice.applyStaged(stagedAlice);
    expect(alice.epoch).toBe(2);

    // Bob loses slot 1 → 409.
    const rB = server.postCommit(stagedBob.epoch, stagedBob.commit);
    expect(rB.ok).toBe(false);
    bob.discardStaged(stagedBob);

    // Bob drains Alice's winning commit (epoch=1 commit, bob is at epoch 1, so afterEpoch=0).
    for (const { wire } of server.getCommitsSince(bob.epoch - 1)) {
      await bob.processCommit(wire, noop);
    }
    expect(bob.epoch).toBe(2);

    // Bob rebases: stages a new commit at epoch 2 and wins slot 2.
    const stagedBob2 = await bob.stageMembershipCommit({ add: [dKeys.publicPackage] });
    expect(stagedBob2.epoch).toBe(2);
    const rB2 = server.postCommit(stagedBob2.epoch, stagedBob2.commit);
    expect(rB2.ok).toBe(true);
    await bob.applyStaged(stagedBob2);
    expect(bob.epoch).toBe(3);

    // Alice drains Bob's commit to sync to epoch 3.
    for (const { wire } of server.getCommitsSince(alice.epoch - 1)) {
      await alice.processCommit(wire, noop);
    }
    expect(alice.epoch).toBe(3);

    // All four members can exchange messages at epoch 3.
    const carol = await engine.joinConversation(cKeys, stagedAlice.invite!);
    await carol.processCommit(stagedBob2.commit, noop); // Carol joined at epoch 2, needs epoch-2 commit
    expect(carol.epoch).toBe(3);

    const msg = await alice.encrypt('all synced');
    expect(await bob.decrypt(msg)).toBe('all synced');
    expect(await carol.decrypt(msg)).toBe('all synced');
  });

  it('pending-adopt-on-reload: serialized pending state matches post-commit epoch', async () => {
    const engine = await MlsEngine.create();
    const server = new MockEpochServer();

    const aKeys = await engine.generateDeviceKeys('alice');
    const bKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv', aKeys);

    // Stage a commit, persist the pending state, simulate process crash before applyStaged.
    const staged = await alice.stageMembershipCommit({ add: [bKeys.publicPackage] });
    const pendingBytes = alice.serializeStaged(staged); // bytes of post-commit state

    // Server POST succeeds.
    const res = server.postCommit(staged.epoch, staged.commit);
    expect(res.ok).toBe(true);

    // On reload: deserialize the sealed pending state → it IS the post-commit state.
    const recovered = engine.deserializeConversation(pendingBytes);
    expect(recovered.epoch).toBe(1);

    // The recovered conversation can exchange messages with Bob.
    const bob = await engine.joinConversation(bKeys, staged.invite!);
    expect(bob.epoch).toBe(1);

    const wire = await recovered.encrypt('message from recovered state');
    expect(await bob.decrypt(wire)).toBe('message from recovered state');
  });

  it('members() returns correct identities and leaf indices; remove decrements roster', async () => {
    const engine = await MlsEngine.create();
    const server = new MockEpochServer();

    const aKeys = await engine.generateDeviceKeys('alice');
    const bKeys = await engine.generateDeviceKeys('bob');
    const alice = await engine.createConversation('conv', aKeys);

    const m1 = alice.members();
    expect(m1).toHaveLength(1);
    expect(m1[0]!.identity).toBe('alice');
    expect(m1[0]!.leafIndex).toBe(0);

    // Add Bob.
    await submit(alice, { add: [bKeys.publicPackage] }, server);
    const m2 = alice.members();
    expect(m2).toHaveLength(2);
    expect(m2.map((m) => m.identity).sort()).toEqual(['alice', 'bob']);

    // Remove Bob.
    const bobLeaf = m2.find((m) => m.identity === 'bob')!;
    await submit(alice, { removeLeafIndices: [bobLeaf.leafIndex] }, server);
    const m3 = alice.members();
    expect(m3).toHaveLength(1);
    expect(m3[0]!.identity).toBe('alice');
  });
});
