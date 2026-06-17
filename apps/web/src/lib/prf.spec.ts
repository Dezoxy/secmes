import { describe, expect, it } from 'vitest';

import { unlockKeyFromResponse, withPrfSalt } from './prf';

// Regression guard for the crypto-blind boundary: the PRF output is the keystore unlock secret, and the
// WebAuthn response is POSTed verbatim to the server's verify endpoint. `unlockKeyFromResponse` MUST strip
// `clientExtensionResults.prf` from the response object (in place, before the caller POSTs it) while still
// returning the derived key. A reorder/refactor that drops the strip would silently re-leak the secret —
// these tests fail loudly if that happens. See docs/threat-models/prf-keystore-unlock.md (T1).

// A 32-byte ArrayBuffer, matching what a real authenticator returns in prf.results.first.
function prfResults(): ArrayBuffer {
  return new Uint8Array(32).fill(7).buffer;
}

describe('prf — crypto-blind boundary', () => {
  it('derives the unlock key AND strips prf from the response (so it never reaches the server)', async () => {
    const response = {
      id: 'cred',
      clientExtensionResults: {
        credProps: { rk: true },
        prf: { results: { first: prfResults() } },
      },
    } as unknown as Parameters<typeof unlockKeyFromResponse>[0];

    const key = await unlockKeyFromResponse(response);

    expect(key).not.toBeNull(); // a 32-byte PRF output → an importable unlock key
    // The secret is gone from the object that gets POSTed; non-secret extension outputs are preserved.
    expect((response.clientExtensionResults as Record<string, unknown>).prf).toBeUndefined();
    expect((response.clientExtensionResults as Record<string, unknown>).credProps).toBeDefined();
    // What actually goes on the wire (JSON.stringify of the response) carries no prf.
    expect(JSON.stringify(response)).not.toContain('prf');
  });

  it('returns null (no throw) when the authenticator returned no PRF output', async () => {
    const response = {
      clientExtensionResults: {},
    } as unknown as Parameters<typeof unlockKeyFromResponse>[0];
    expect(await unlockKeyFromResponse(response)).toBeNull();
  });

  it('rejects a malformed PRF output (not 32 bytes) as no-PRF, and still strips it', async () => {
    const response = {
      clientExtensionResults: { prf: { results: { first: new Uint8Array(16).buffer } } },
    } as unknown as Parameters<typeof unlockKeyFromResponse>[0];
    expect(await unlockKeyFromResponse(response)).toBeNull();
    expect((response.clientExtensionResults as Record<string, unknown>).prf).toBeUndefined();
  });

  it('injects the fixed 32-byte PRF salt as raw bytes into the ceremony options', () => {
    const options = {} as Parameters<typeof withPrfSalt>[0];
    withPrfSalt(options);
    const first = (options.extensions as { prf?: { eval?: { first?: unknown } } } | undefined)?.prf
      ?.eval?.first;
    expect(first).toBeInstanceOf(Uint8Array);
    expect((first as Uint8Array).length).toBe(32);
  });

  it('uses the SAME salt every call (stability — a drift would orphan every keystore)', () => {
    const a = {} as Parameters<typeof withPrfSalt>[0];
    const b = {} as Parameters<typeof withPrfSalt>[0];
    withPrfSalt(a);
    withPrfSalt(b);
    const saltA = (a.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first;
    const saltB = (b.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first;
    expect([...saltA]).toEqual([...saltB]);
  });
});
