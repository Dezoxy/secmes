import { describe, expect, it, beforeAll } from 'vitest';

import {
  MlsEngine,
  safetyNumber,
  safetyNumberFromMember,
  type GroupMember,
  type KeyPackage,
} from './index.js';

/** Build a GroupMember view from a KeyPackage — mirrors what Conversation.members() returns. */
function memberFromKp(kp: KeyPackage, leafIndex = 0): GroupMember {
  const cred = kp.leafNode.credential;
  if (cred.credentialType !== 'basic') throw new Error('expected basic credential');
  // Decode the raw credential bytes to a string — exactly the inverse of what safetyNumberFromMember
  // re-encodes. This round-trip must be lossless (strict UTF-8); the C2 tests prove it.
  const identity = new TextDecoder('utf-8', { fatal: true }).decode(cred.identity);
  return { leafIndex, identity, signaturePublicKey: kp.leafNode.signaturePublicKey };
}

// Out-of-band safety number (checkpoint 20) — the MITM defense. See fingerprint-verification.md.
describe('safety number', () => {
  let engine: MlsEngine;
  beforeAll(async () => {
    engine = await MlsEngine.create();
  });

  it('is symmetric (both peers compute the same string) and deterministic', async () => {
    const alice = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');

    const ab = await safetyNumber(alice.publicPackage, bob.publicPackage);
    const ba = await safetyNumber(bob.publicPackage, alice.publicPackage);

    expect(ab).toBe(ba); // symmetric — the sort makes both sides agree
    expect(await safetyNumber(alice.publicPackage, bob.publicPackage)).toBe(ab); // deterministic
    const parts = ab.split(' '); // 8 groups of 5 digits
    expect(parts).toHaveLength(8);
    expect(parts.every((p) => /^\d{5}$/.test(p))).toBe(true);
  });

  it('differs for a different peer key (a swapped key is detectable)', async () => {
    const alice = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');
    const mallory = await engine.generateDeviceKeys('bob@argus.local'); // same name, different keys

    // An attacker who substitutes their own key under the peer's name yields a different number.
    expect(await safetyNumber(alice.publicPackage, mallory.publicPackage)).not.toBe(
      await safetyNumber(alice.publicPackage, bob.publicPackage),
    );
  });

  it('is stable across KeyPackage re-mints (recovery preserves the identity key)', async () => {
    const alice = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');

    // Recover Alice's device from identity-only material — a fresh KeyPackage, same signature identity.
    const aliceReminted = await engine.deviceFromIdentity(engine.exportIdentity(alice));

    // The safety number must NOT change just because Alice re-minted her KeyPackage — otherwise every
    // recovery would look like a MITM and users would learn to ignore mismatches.
    expect(await safetyNumber(aliceReminted.publicPackage, bob.publicPackage)).toBe(
      await safetyNumber(alice.publicPackage, bob.publicPackage),
    );
  });

  it('binds the identity string, not just the key (same key, different name → different number)', async () => {
    const a1 = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');
    // Re-mint Alice's identity under a DIFFERENT name but the same signature key.
    const renamed = await engine.deviceFromIdentity({
      ...engine.exportIdentity(a1),
      identity: 'eve@argus.local',
    });
    expect(await safetyNumber(renamed.publicPackage, bob.publicPackage)).not.toBe(
      await safetyNumber(a1.publicPackage, bob.publicPackage),
    );
  });
});

// safetyNumberFromMember — roster-member variant. C2 cross-consistency is the hard release gate:
// both paths (KeyPackage and GroupMember) must produce the same number for the same underlying keys.
describe('safetyNumberFromMember', () => {
  let engine: MlsEngine;
  beforeAll(async () => {
    engine = await MlsEngine.create();
  });

  it('C2: produces the same number as safetyNumber() for the same underlying keys (ASCII identity)', async () => {
    const alice = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');

    const fromKp = await safetyNumber(alice.publicPackage, bob.publicPackage);
    const fromMember = await safetyNumberFromMember(
      memberFromKp(alice.publicPackage),
      memberFromKp(bob.publicPackage),
    );
    expect(fromMember).toBe(fromKp);
  });

  it('C2: cross-consistency holds for a non-ASCII multi-byte UTF-8 identity (no ASCII-only shortcuts)', async () => {
    // "user:\u{1F512}-device" contains a 4-byte UTF-8 code point (U+1F512 LOCK).
    // Round-trip: MLS encodes identity to UTF-8 bytes; memberFromKp decodes strict-UTF-8;
    // safetyNumberFromMember re-encodes with TextEncoder — must be lossless.
    const alice = await engine.generateDeviceKeys('user:\u{1F512}-device');
    const bob = await engine.generateDeviceKeys('bob@argus.local');

    const fromKp = await safetyNumber(alice.publicPackage, bob.publicPackage);
    const fromMember = await safetyNumberFromMember(
      memberFromKp(alice.publicPackage),
      memberFromKp(bob.publicPackage),
    );
    expect(fromMember).toBe(fromKp);
  });

  it('is symmetric (safetyNumberFromMember(a, b) === safetyNumberFromMember(b, a))', async () => {
    const alice = await engine.generateDeviceKeys('alice@argus.local');
    const bob = await engine.generateDeviceKeys('bob@argus.local');

    const ab = await safetyNumberFromMember(
      memberFromKp(alice.publicPackage),
      memberFromKp(bob.publicPackage),
    );
    const ba = await safetyNumberFromMember(
      memberFromKp(bob.publicPackage),
      memberFromKp(alice.publicPackage),
    );
    expect(ab).toBe(ba);
  });
});
