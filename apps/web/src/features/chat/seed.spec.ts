import { describe, expect, it } from 'vitest';

import { dicebearAvatar } from '../../lib/dicebear';
import { conversations, generatedAvatar, initialConversationsForMode, safeAvatarSrc } from './seed';

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

describe('safeAvatarSrc — avatar gate', () => {
  it('passes through app-generated DiceBear SVG data-URIs (so portraits actually render)', () => {
    const dice = dicebearAvatar('user-123');
    expect(dice.startsWith('data:image/svg+xml,')).toBe(true);
    expect(safeAvatarSrc(dice, 'Someone')).toBe(dice);
  });

  it('passes through the generated initials SVG', () => {
    const gen = generatedAvatar('Ada Lovelace');
    expect(safeAvatarSrc(gen, 'Different Name')).toBe(gen);
  });

  it('passes through an uploaded raster photo data-URI', () => {
    const raster = 'data:image/png;base64,iVBORw0KGgo=';
    expect(safeAvatarSrc(raster, 'X')).toBe(raster);
  });

  it('falls back to initials for missing / non-image / external src', () => {
    const fallback = generatedAvatar('X');
    expect(safeAvatarSrc(undefined, 'X')).toBe(fallback);
    expect(safeAvatarSrc('javascript:alert(1)', 'X')).toBe(fallback);
    expect(safeAvatarSrc('https://evil.example/x.svg', 'X')).toBe(fallback);
  });

  it('falls back when a data-URI exceeds the max length', () => {
    const huge = `data:image/svg+xml,${'a'.repeat(200_000)}`;
    expect(safeAvatarSrc(huge, 'X')).toBe(generatedAvatar('X'));
  });
});
