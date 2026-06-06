import { describe, expect, it } from 'vitest';

import {
  generateSignatureKeypair,
  signWelcomeConsume,
  verifyWelcomeConsume,
} from './device-proof.js';

const deviceId = '11111111-1111-1111-1111-111111111111';
const welcomeId = '22222222-2222-2222-2222-222222222222';

describe('device-proof (welcome consume)', () => {
  it('verifies a proof made by the matching device key', () => {
    const { privateKey, publicKey } = generateSignatureKeypair();
    const sig = signWelcomeConsume(privateKey, deviceId, welcomeId);
    expect(verifyWelcomeConsume(publicKey, deviceId, welcomeId, sig)).toBe(true);
  });

  it("rejects a proof from a different key (a sibling device can't forge)", () => {
    const a = generateSignatureKeypair();
    const b = generateSignatureKeypair();
    const sig = signWelcomeConsume(a.privateKey, deviceId, welcomeId);
    expect(verifyWelcomeConsume(b.publicKey, deviceId, welcomeId, sig)).toBe(false);
  });

  it('is bound to the deviceId and welcomeId (changing either fails)', () => {
    const { privateKey, publicKey } = generateSignatureKeypair();
    const sig = signWelcomeConsume(privateKey, deviceId, welcomeId);
    expect(
      verifyWelcomeConsume(publicKey, '33333333-3333-3333-3333-333333333333', welcomeId, sig),
    ).toBe(false);
    expect(
      verifyWelcomeConsume(publicKey, deviceId, '44444444-4444-4444-4444-444444444444', sig),
    ).toBe(false);
  });

  it('rejects a tampered signature without throwing', () => {
    const { privateKey, publicKey } = generateSignatureKeypair();
    const sig = signWelcomeConsume(privateKey, deviceId, welcomeId);
    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(verifyWelcomeConsume(publicKey, deviceId, welcomeId, tampered)).toBe(false);
  });

  it('rejects a malformed public key without throwing', () => {
    const { privateKey } = generateSignatureKeypair();
    const sig = signWelcomeConsume(privateKey, deviceId, welcomeId);
    expect(verifyWelcomeConsume(new Uint8Array(5), deviceId, welcomeId, sig)).toBe(false);
    // a wrong-length (33-byte) public key must also fail closed, not throw
    expect(verifyWelcomeConsume(new Uint8Array(33), deviceId, welcomeId, sig)).toBe(false);
  });

  it('rejects a malformed / wrong-length signature without throwing', () => {
    const { publicKey } = generateSignatureKeypair();
    // the totality of verify() is load-bearing: a throw would surface as a 500, not an opaque 404
    expect(verifyWelcomeConsume(publicKey, deviceId, welcomeId, new Uint8Array(0))).toBe(false);
    expect(verifyWelcomeConsume(publicKey, deviceId, welcomeId, new Uint8Array(10))).toBe(false);
    expect(verifyWelcomeConsume(publicKey, deviceId, welcomeId, new Uint8Array(63))).toBe(false);
  });
});
