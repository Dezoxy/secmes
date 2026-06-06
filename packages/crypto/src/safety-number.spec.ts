import { describe, expect, it, beforeAll } from 'vitest';

import { MlsEngine, safetyNumber } from './index.js';

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
