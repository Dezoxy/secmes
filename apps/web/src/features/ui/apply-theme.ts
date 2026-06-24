import { getAccentById, type AccentId } from './theme';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const MIN_WHITE_TEXT_CONTRAST = 4.5;
const SOLID_ACCENT_TARGET_CONTRAST = 4.75;
const WHITE_LUMINANCE = 1;

function parseHexColor(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return { r: 124, g: 58, b: 237 };
  const value = match[1]!;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function toHexChannel(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');
}

function toHexColor({ r, g, b }: Rgb): string {
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b)}`;
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastWithWhite(hex: string): number {
  const backgroundLuminance = luminance(parseHexColor(hex));
  return (WHITE_LUMINANCE + 0.05) / (backgroundLuminance + 0.05);
}

function mix(first: Rgb, second: Rgb, secondWeight: number): Rgb {
  const firstWeight = 1 - secondWeight;
  return {
    r: first.r * firstWeight + second.r * secondWeight,
    g: first.g * firstWeight + second.g * secondWeight,
    b: first.b * firstWeight + second.b * secondWeight,
  };
}

export function solidAccentForWhiteText(hex: string): string {
  const accent = parseHexColor(hex);
  const black = { r: 0, g: 0, b: 0 };
  for (let weight = 0; weight <= 0.75; weight += 0.01) {
    const candidate = toHexColor(mix(accent, black, weight));
    if (contrastWithWhite(candidate) >= SOLID_ACCENT_TARGET_CONTRAST) return candidate;
  }
  return toHexColor(mix(accent, black, 0.75));
}

function hoverAccentForWhiteText(hex: string): string {
  const accent = parseHexColor(hex);
  const white = { r: 255, g: 255, b: 255 };
  for (let weight = 0.12; weight >= 0; weight -= 0.01) {
    const candidate = toHexColor(mix(accent, white, weight));
    if (contrastWithWhite(candidate) >= MIN_WHITE_TEXT_CONTRAST) return candidate;
  }
  return hex;
}

export function applyThemeToDocument(accentId: AccentId, fontSizeLevel: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const accent = getAccentById(accentId);
  const solidAccent = solidAccentForWhiteText(accent.hex);
  const hover = hoverAccentForWhiteText(solidAccent);

  root.style.setProperty('--argus-color-accent', accent.hex);
  root.style.setProperty('--argus-color-accent-hover', hover);
  root.style.setProperty('--argus-color-accent-soft', accent.soft);
  // Tailwind v4 purple palette — keeps bg-purple-* / text-purple-* utilities in sync with the accent.
  root.style.setProperty('--color-purple-100', `color-mix(in srgb, ${accent.hex} 20%, white)`);
  root.style.setProperty('--color-purple-200', `color-mix(in srgb, ${accent.hex} 40%, white)`);
  root.style.setProperty('--color-purple-300', `color-mix(in srgb, ${accent.hex} 60%, white)`);
  root.style.setProperty('--color-purple-400', hover);
  root.style.setProperty('--color-purple-500', solidAccent);
  root.style.setProperty('--color-purple-600', `color-mix(in srgb, ${solidAccent} 80%, black)`);
  root.style.setProperty('--color-purple-700', `color-mix(in srgb, ${solidAccent} 60%, black)`);
  root.style.setProperty('--color-purple-950', `color-mix(in srgb, ${accent.hex} 20%, black)`);
  // Level 5 = 100% (browser default), step = 5%/level, range 80%–125%
  root.style.setProperty('--argus-font-size', `${80 + (fontSizeLevel - 1) * 5}%`);
}
