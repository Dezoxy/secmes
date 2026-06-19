import { describe, expect, it } from 'vitest';

import { checkAssetIntegrity, integrityManifestKey, sha384Base64 } from './sw-integrity';

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Known-good SHA-384 base64 vectors (computed independently with `openssl dgst -sha384 -binary | base64` /
// node:crypto) — a real cross-check, not the function compared against itself.
const PAYLOAD_A = 'console.log("real crypto chunk")';
const HASH_A = 'Wh6xjlw8g58+rxtKPAxFDxHPfXCYwYTGQ4xRlSn6/nuxPUJAE5T+SygaCqeLI5l0';
const CHUNK = 'the genuine ts-mls crypto chunk';
const HASH_CHUNK = '71TiZynIYbBq6m8tjzPjmpv6k1aDAylonHeFFKaDOHBvZZm2A2YZ9NNuHuOWiBdY';

// The SW integrity gate (CDI-1). The whole point: a swapped crypto chunk (nist-*, ed448-*, …) must be
// refused before it can run inside the crypto boundary, while unknown paths must pass through untouched so
// a mid-deploy version skew never bricks the app. See docs/threat-models/code-delivery-integrity.md.
describe('sw-integrity', () => {
  describe('sha384Base64', () => {
    it('matches the base64 SHA-384 that bundle-manifest.json / SRI use', async () => {
      expect(await sha384Base64(bytes(PAYLOAD_A))).toBe(HASH_A);
    });
  });

  describe('integrityManifestKey', () => {
    it('maps a request path to its dist-relative manifest key', () => {
      expect(integrityManifestKey('/assets/nist-D6IHJPI4.js')).toBe('assets/nist-D6IHJPI4.js');
    });
    it('returns null for the root path', () => {
      expect(integrityManifestKey('/')).toBeNull();
    });
  });

  describe('checkAssetIntegrity', () => {
    it('passes a known asset whose bytes match the manifest hash', async () => {
      expect(await checkAssetIntegrity(HASH_CHUNK, bytes(CHUNK))).toEqual({
        guarded: true,
        ok: true,
      });
    });

    it('FAILS CLOSED when a guarded chunk is tampered (one flipped byte)', async () => {
      const tampered = `${CHUNK}X`; // attacker-swapped bytes, same manifest entry
      const decision = await checkAssetIntegrity(HASH_CHUNK, bytes(tampered));
      expect(decision.guarded).toBe(true);
      expect(decision.ok).toBe(false); // refused — the import() rejects, crypto op errors out
    });

    it('passes through an UNKNOWN path untouched (mid-deploy skew must not brick the app)', async () => {
      // A new build's chunk name is absent from an already-installed SW's manifest → expected is undefined
      // → it must fall through to the network, never be falsely rejected.
      expect(await checkAssetIntegrity(undefined, bytes('any future chunk'))).toEqual({
        guarded: false,
        ok: true,
      });
    });
  });
});
