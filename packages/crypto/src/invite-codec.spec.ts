import { describe, expect, it } from 'vitest';

import { MlsEngine, deserializeInvite, serializeInvite } from './index.js';

// Slice 3 (start a 1:1): the initiator's `addMember` yields a ConversationInvite (Welcome + RatchetTree)
// that must travel to the recipient as opaque base64 through the crypto-blind server. These tests prove
// the wire codec is faithful — a round-tripped invite reconstructs a working group — and that it fits the
// welcomes endpoint's per-field size cap. (Until now the 2-device harness passed the invite in-memory and
// never exercised the base64 boundary; delivery requires it.)

const MAX_FIELD = 32768; // DeliverWelcomeSchema: welcome/ratchetTree are base64.min(1).max(32768)

describe('invite codec (serializeInvite / deserializeInvite)', () => {
  it('round-trips through base64 so the recipient joins and both directions decrypt', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice-device');
    const bobKeys = await engine.generateDeviceKeys('bob-device');

    const alice = await engine.createConversation('room', aliceKeys);
    const invite = await alice.addMember(bobKeys.publicPackage);

    // Simulate delivery via the crypto-blind server: only opaque base64 strings cross the wire.
    const wire = serializeInvite(invite);
    expect(typeof wire.welcome).toBe('string');
    expect(typeof wire.ratchetTree).toBe('string');

    // The recipient reconstructs the invite from the wire form and joins.
    const bob = await engine.joinConversation(bobKeys, deserializeInvite(wire));

    // A faithful round-trip ⟹ a working shared group in both directions.
    const SECRET = 'hello across the wire';
    expect(await bob.decrypt(await alice.encrypt(SECRET))).toBe(SECRET);
    expect(await alice.decrypt(await bob.encrypt('ack'))).toBe('ack');
  });

  it('emits decodable base64 within the welcomes endpoint size cap', async () => {
    const engine = await MlsEngine.create();
    const aliceKeys = await engine.generateDeviceKeys('alice-device');
    const bobKeys = await engine.generateDeviceKeys('bob-device');

    const alice = await engine.createConversation('room', aliceKeys);
    const wire = serializeInvite(await alice.addMember(bobKeys.publicPackage));

    expect(() => atob(wire.welcome)).not.toThrow();
    expect(() => atob(wire.ratchetTree)).not.toThrow();
    expect(wire.welcome.length).toBeLessThanOrEqual(MAX_FIELD);
    expect(wire.ratchetTree.length).toBeLessThanOrEqual(MAX_FIELD);
  });
});
