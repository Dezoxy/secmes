import { describe, expect, it } from 'vitest';

import { MlsEngine } from './index.js';

// Checkpoint 16a — headless 2-device harness: encrypt → send → fetch → decrypt across two simulated
// devices through a mock server that only ever holds opaque ciphertext (proves the crypto-blind model).

/** A trivial in-memory "server": stores ciphertext blobs per recipient. It cannot read them. */
class MockServer {
  private readonly inbox = new Map<string, Uint8Array[]>();
  send(to: string, wire: Uint8Array): void {
    const q = this.inbox.get(to) ?? [];
    q.push(wire);
    this.inbox.set(to, q);
  }
  fetch(who: string): Uint8Array[] {
    const q = this.inbox.get(who) ?? [];
    this.inbox.set(who, []);
    return q;
  }
}

/** Does `haystack` contain the UTF-8 bytes of `needle` anywhere? (Used to prove plaintext never leaks.) */
function containsUtf8(haystack: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  for (let i = 0; i + n.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < n.length; j++) {
      if (haystack[i + j] !== n[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

describe('headless 2-device harness (checkpoint 16a)', () => {
  it('encrypt → send → fetch → decrypt across two devices; the server stays blind', async () => {
    const engine = await MlsEngine.create();
    const server = new MockServer();

    // Two simulated devices, each holding its own keys + conversation state.
    const aliceKeys = await engine.generateDeviceKeys('alice-device');
    const bobKeys = await engine.generateDeviceKeys('bob-device');
    const alice = await engine.createConversation('room', aliceKeys);
    const bob = await engine.joinConversation(
      bobKeys,
      await alice.addMember(bobKeys.publicPackage),
    );

    const SECRET = 'launch codes: 0000-1111';
    server.send('bob', await alice.encrypt(SECRET));

    const blobs = server.fetch('bob');
    expect(blobs).toHaveLength(1);
    const [blob] = blobs;
    if (!blob) throw new Error('expected one ciphertext blob');

    // Crypto-blind proof: the bytes the server held contain none of the plaintext.
    expect(containsUtf8(blob, SECRET)).toBe(false);
    expect(containsUtf8(blob, 'launch codes')).toBe(false);

    expect(await bob.decrypt(blob)).toBe(SECRET);

    // Reply path the same way.
    server.send('alice', await bob.encrypt('acknowledged'));
    const back = server.fetch('alice');
    const [reply] = back;
    if (!reply) throw new Error('expected one reply blob');
    expect(await alice.decrypt(reply)).toBe('acknowledged');
  });
});
