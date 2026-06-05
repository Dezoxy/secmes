import { describe, expect, it } from 'vitest';

import { PublishKeyPackagesSchema } from './key-directory.schemas.js';

const b64 = 'AAAA';

describe('PublishKeyPackagesSchema', () => {
  it('accepts well-formed base64 within bounds', () => {
    expect(
      PublishKeyPackagesSchema.safeParse({ signaturePublicKey: b64, keyPackages: [b64] }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict, fail-closed)', () => {
    const r = PublishKeyPackagesSchema.safeParse({
      signaturePublicKey: b64,
      keyPackages: [b64],
      extra: 'nope',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-base64, an empty pool, and an over-cap pool', () => {
    expect(
      PublishKeyPackagesSchema.safeParse({ signaturePublicKey: 'not base64!', keyPackages: [b64] })
        .success,
    ).toBe(false);
    expect(
      PublishKeyPackagesSchema.safeParse({ signaturePublicKey: b64, keyPackages: [] }).success,
    ).toBe(false);
    expect(
      PublishKeyPackagesSchema.safeParse({
        signaturePublicKey: b64,
        keyPackages: Array.from({ length: 101 }, () => b64),
      }).success,
    ).toBe(false);
  });
});
