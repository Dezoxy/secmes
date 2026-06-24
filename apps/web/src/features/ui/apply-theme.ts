import { getAccentById, type AccentId } from './theme';

export function applyThemeToDocument(accentId: AccentId, fontSizeLevel: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const accent = getAccentById(accentId);

  root.style.setProperty('--argus-color-accent', accent.hex);
  root.style.setProperty(
    '--argus-color-accent-hover',
    `color-mix(in srgb, ${accent.hex} 80%, white)`,
  );
  root.style.setProperty('--argus-color-accent-soft', accent.soft);
  // Level 5 = 100% (browser default), step = 5%/level, range 80%–125%
  root.style.setProperty('--argus-font-size', `${80 + (fontSizeLevel - 1) * 5}%`);
}
