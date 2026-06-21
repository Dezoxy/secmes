import { describe, expect, it } from 'vitest';
import { displayNameSchema } from '@argus/contracts';

import {
  generateHandle,
  HANDLE_ADJECTIVES,
  HANDLE_ANIMALS,
  HANDLE_POOL_SIZE,
} from './handle-words.js';

// Pure unit test (no DB) — guards the handle word-list invariants + generation format. #44b.
describe('handle-words', () => {
  it('has 200 unique adjectives and 200 unique animals (a 40k-handle pool)', () => {
    expect(HANDLE_ADJECTIVES).toHaveLength(200);
    expect(new Set(HANDLE_ADJECTIVES).size).toBe(200); // no duplicates
    expect(HANDLE_ANIMALS).toHaveLength(200);
    expect(new Set(HANDLE_ANIMALS).size).toBe(200);
    expect(HANDLE_POOL_SIZE).toBe(40_000);
  });

  it('every word is a single, capitalized token (so "Adjective Animal" splits cleanly)', () => {
    for (const word of [...HANDLE_ADJECTIVES, ...HANDLE_ANIMALS]) {
      expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('generateHandle produces "Adjective Animal" drawn from the lists', () => {
    for (let i = 0; i < 100; i += 1) {
      const handle = generateHandle();
      const parts = handle.split(' ');
      expect(parts).toHaveLength(2);
      expect(HANDLE_ADJECTIVES as readonly string[]).toContain(parts[0]);
      expect(HANDLE_ANIMALS as readonly string[]).toContain(parts[1]);
    }
  });

  it('spreads across the pool (not a constant) — CSPRNG-backed selection', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateHandle()));
    // 200 draws from 40k should yield many distinct values; a stuck generator would collapse to ~1.
    expect(seen.size).toBeGreaterThan(150);
  });

  // The auto-assigned handle must always satisfy the hardened display-name policy, so registration can
  // never mint a name a user would then be unable to keep or edit. Guard the worst case statically
  // (longest adjective + space + longest animal ≤ 32) and a large random sample dynamically.
  it('every possible handle is a valid display name (Latin, ≤ 32 chars)', () => {
    const longestAdjective = Math.max(...HANDLE_ADJECTIVES.map((w) => w.length));
    const longestAnimal = Math.max(...HANDLE_ANIMALS.map((w) => w.length));
    expect(longestAdjective + 1 + longestAnimal).toBeLessThanOrEqual(32);

    for (let i = 0; i < 500; i += 1) {
      expect(displayNameSchema.safeParse(generateHandle()).success).toBe(true);
    }
  });
});
