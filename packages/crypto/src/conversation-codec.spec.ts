import { describe, expect, it } from 'vitest';

import { MlsEngine } from './index.js';

// Slice 5 (group-state persistence): MLS group state ratchets on every encrypt/decrypt, so it must be saved
// durably (sealed) or a reload desyncs the group. `Conversation.serialize()` → `encodeGroupState`;
// `MlsEngine.deserializeConversation()` → `decodeGroupState` + re-attached default clientConfig. These tests
// prove the round-trip preserves the LIVE ratchet — a restored group keeps encrypting/decrypting in order,
// continuing exactly where the original left off (a reset or torn state would fail to decrypt).

describe('conversation persistence codec', () => {
  it('round-trips a group so the restored instance continues the ratchet in both directions', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const aliceConv = await engine.createConversation('room', alice);
    const bobConv = await engine.joinConversation(
      bob,
      await aliceConv.addMember(bob.publicPackage),
    );

    // Alice sends one (advancing her sending ratchet); bob receives it.
    expect(await bobConv.decrypt(await aliceConv.encrypt('one'))).toBe('one');

    // Persist Alice's group state and restore it (as on a reload) — the original is then discarded.
    const restored = engine.deserializeConversation(await aliceConv.serialize());

    // The RESTORED group continues the ratchet, not a reset: its next message decrypts for bob, in order…
    expect(await bobConv.decrypt(await restored.encrypt('two'))).toBe('two');
    // …and the reverse direction still works against the restored state.
    expect(await restored.decrypt(await bobConv.encrypt('three'))).toBe('three');
  });

  it('round-trips after several messages (full ratchet/secret-tree state survives)', async () => {
    const engine = await MlsEngine.create();
    const alice = await engine.generateDeviceKeys('alice');
    const bob = await engine.generateDeviceKeys('bob');
    const aliceConv = await engine.createConversation('room', alice);
    const bobConv = await engine.joinConversation(
      bob,
      await aliceConv.addMember(bob.publicPackage),
    );

    for (const m of ['a', 'b', 'c', 'd']) {
      expect(await bobConv.decrypt(await aliceConv.encrypt(m))).toBe(m);
    }

    // Restore BOTH sides from serialized state, then keep talking — proves both directions' state persists.
    const aliceR = engine.deserializeConversation(await aliceConv.serialize());
    const bobR = engine.deserializeConversation(await bobConv.serialize());
    expect(await bobR.decrypt(await aliceR.encrypt('after-reload'))).toBe('after-reload');
    expect(await aliceR.decrypt(await bobR.encrypt('and-back'))).toBe('and-back');
  });

  it('throws on malformed group-state bytes', async () => {
    const engine = await MlsEngine.create();
    expect(() => engine.deserializeConversation(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
