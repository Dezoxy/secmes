import { getAccentById, type AccentId } from './theme';

export function applyThemeToDocument(accentId: AccentId, fontSizeLevel: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const accent = getAccentById(accentId);
  const hover = `color-mix(in srgb, ${accent.hex} 80%, white)`;

  root.style.setProperty('--argus-color-accent', accent.hex);
  root.style.setProperty('--argus-color-accent-hover', hover);
  root.style.setProperty('--argus-color-accent-soft', accent.soft);
  // Tailwind v4 purple palette — keeps bg-purple-* / text-purple-* utilities in sync with the accent.
  root.style.setProperty('--color-purple-100', `color-mix(in srgb, ${accent.hex} 20%, white)`);
  root.style.setProperty('--color-purple-200', `color-mix(in srgb, ${accent.hex} 40%, white)`);
  root.style.setProperty('--color-purple-300', `color-mix(in srgb, ${accent.hex} 60%, white)`);
  root.style.setProperty('--color-purple-400', hover);
  root.style.setProperty('--color-purple-500', accent.hex);
  root.style.setProperty('--color-purple-600', `color-mix(in srgb, ${accent.hex} 80%, black)`);
  root.style.setProperty('--color-purple-700', `color-mix(in srgb, ${accent.hex} 60%, black)`);
  root.style.setProperty('--color-purple-950', `color-mix(in srgb, ${accent.hex} 20%, black)`);
  // Level 5 = 100% (browser default), step = 5%/level, range 80%–125%
  root.style.setProperty('--argus-font-size', `${80 + (fontSizeLevel - 1) * 5}%`);
}
