import { describe, expect, it } from 'vitest';
import {
  accentOptions,
  argusColorTokens,
  argusRadiusTokens,
  argusShadowTokens,
  argusSpaceTokens,
  defaultAccentId,
  getAccentById,
  isAccentId,
} from './theme';

describe('argus theme tokens', () => {
  it('keeps purple as the default accent', () => {
    expect(defaultAccentId).toBe('purple');
    expect(getAccentById(defaultAccentId)).toMatchObject({
      id: 'purple',
      label: 'Argus Purple',
      hex: '#a855f7',
      soft: 'rgba(168,85,247,0.2)',
    });
  });

  it('preserves the user-selectable accent color list shape', () => {
    expect(accentOptions).toHaveLength(11);

    const ids = new Set<string>();
    for (const accent of accentOptions) {
      expect(accent.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(accent.label.trim().length).toBeGreaterThan(0);
      expect(accent.hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(accent.soft).toMatch(/^rgba\(\d+,\d+,\d+,0\.\d+\)$/);
      expect(ids.has(accent.id)).toBe(false);
      ids.add(accent.id);
      expect(isAccentId(accent.id)).toBe(true);
    }

    expect(isAccentId('')).toBe(false);
    expect(isAccentId('password')).toBe(false);
  });

  it('defines the core color, spacing, radius, and shadow tokens', () => {
    expect(argusColorTokens).toMatchObject({
      appBackground: '#1a1a24',
      panel: '#12121a',
      panelSubtle: '#0f0f16',
      border: 'rgb(255 255 255 / 5%)',
      text: 'rgb(255 255 255 / 92%)',
      textMuted: 'rgb(255 255 255 / 45%)',
      danger: '#f43f5e',
      success: '#22c55e',
      accent: '#a855f7',
    });
    expect(argusSpaceTokens[4]).toBe('1rem');
    expect(argusRadiusTokens.lg).toBe('1rem');
    expect(argusShadowTokens.panel).toContain('rgb(0 0 0 / 50%)');
  });
});
