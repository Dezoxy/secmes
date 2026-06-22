import { describe, expect, it } from 'vitest';

import { conversations, initialConversationsForMode } from './seed';

describe('initialConversationsForMode — demo seed gating', () => {
  it('seeds the demo conversations in demo mode (E2E / explorable UI)', () => {
    const result = initialConversationsForMode(true);
    expect(result).toBe(conversations);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns an empty list in real (prod) mode so demo chats never leak to users', () => {
    expect(initialConversationsForMode(false)).toEqual([]);
  });
});
