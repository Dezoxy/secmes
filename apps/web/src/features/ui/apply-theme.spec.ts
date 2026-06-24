import { describe, expect, it } from 'vitest';
import { accentOptions } from './theme';
import { contrastWithWhite, solidAccentForWhiteText } from './apply-theme';

describe('accent theme application helpers', () => {
  it('derives solid accent backgrounds with AA contrast for white text', () => {
    for (const accent of accentOptions) {
      const solidAccent = solidAccentForWhiteText(accent.hex);

      expect(solidAccent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastWithWhite(solidAccent)).toBeGreaterThanOrEqual(4.75);
    }
  });

  it('darkens the default accent that powers white-on-accent surfaces', () => {
    const defaultAccent = accentOptions[0]!;
    const solidAccent = solidAccentForWhiteText(defaultAccent.hex);

    expect(contrastWithWhite(defaultAccent.hex)).toBeLessThan(4.5);
    expect(solidAccent).not.toBe(defaultAccent.hex);
    expect(contrastWithWhite(solidAccent)).toBeGreaterThanOrEqual(4.75);
  });
});
