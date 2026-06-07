import { describe, expect, it } from 'vitest';

import { MlsEngine, NoMatchingPoolMember, deserializeInvite, serializeInvite } from './index.js';

// Slice 4 (join on connect): a Welcome is HPKE-sealed to ONE of the recipient's published one-time
// KeyPackages, so the recipient must join with the matching retained private out of its whole pool.
// `joinConversationFromPool` selects it by matching each member's key_package_ref against the Welcome's
// `secrets[].newMember`. These tests prove the match is exact (the right member joins + decrypts) and that
// a Welcome targeting a key NOT in the pool fails cleanly (a stranded package — skip, don't corrupt).

describe('joinConversationFromPool', () => {
  it('selects the retained pool member the Welcome was sealed to and joins through the wire', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    // Bob's pool: distinct one-time KeyPackages under one stable identity (like the published pool).
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob), await engine.mintKeyPackage(bob)];
    const target = pool[1]!; // the directory hands Alice THIS one

    const aliceConv = await engine.createConversation('room', alice);
    const invite = await aliceConv.addMember(target.publicPackage);

    // Through the base64 wire boundary, Bob joins by selecting the matching retained private.
    const { conversation, member } = await engine.joinConversationFromPool(
      pool,
      deserializeInvite(serializeInvite(invite)),
    );

    // The matched member is exactly the one the Welcome was sealed to…
    expect(await engine.keyPackageRef(member)).toEqual(await engine.keyPackageRef(target));
    // …and the join produced a working shared group.
    const SECRET = 'sealed to exactly one of my keys';
    expect(await conversation.decrypt(await aliceConv.encrypt(SECRET))).toBe(SECRET);
  });

  it('throws NoMatchingPoolMember for a Welcome targeting a key not in the pool, leaving the pool usable', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const pool = [bob, await engine.mintKeyPackage(bob)];

    // A fresh one-time KeyPackage under Bob's identity that was NEVER retained in his pool (a stranded
    // package: its private is not held here).
    const stranded = await engine.mintKeyPackage(bob);
    const aliceConv = await engine.createConversation('room', alice);
    const orphan = await aliceConv.addMember(stranded.publicPackage);

    await expect(
      engine.joinConversationFromPool(pool, deserializeInvite(serializeInvite(orphan))),
    ).rejects.toBeInstanceOf(NoMatchingPoolMember);

    // The pool is untouched — a correct Welcome to a real pool member still joins.
    const aliceConv2 = await engine.createConversation('room2', alice);
    const good = await aliceConv2.addMember(pool[1]!.publicPackage);
    const { member } = await engine.joinConversationFromPool(
      pool,
      deserializeInvite(serializeInvite(good)),
    );
    expect(await engine.keyPackageRef(member)).toEqual(await engine.keyPackageRef(pool[1]!));
  });
});
