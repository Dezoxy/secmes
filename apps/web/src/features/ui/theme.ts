export const defaultAccentId = 'purple';

export const accentOptions = [
  { id: defaultAccentId, label: 'Argus Purple', hex: '#a855f7', soft: 'rgba(168,85,247,0.2)' },
  { id: 'blue', label: 'Signal Blue', hex: '#3b82f6', soft: 'rgba(59,130,246,0.2)' },
  { id: 'cyan', label: 'Cipher Cyan', hex: '#06b6d4', soft: 'rgba(6,182,212,0.2)' },
  { id: 'teal', label: 'Secure Teal', hex: '#14b8a6', soft: 'rgba(20,184,166,0.2)' },
  { id: 'emerald', label: 'Vault Green', hex: '#22c55e', soft: 'rgba(34,197,94,0.2)' },
  { id: 'lime', label: 'Key Lime', hex: '#84cc16', soft: 'rgba(132,204,22,0.2)' },
  { id: 'amber', label: 'Amber Lock', hex: '#f59e0b', soft: 'rgba(245,158,11,0.2)' },
  { id: 'orange', label: 'Burnt Orange', hex: '#f97316', soft: 'rgba(249,115,22,0.2)' },
  { id: 'rose', label: 'Rose Red', hex: '#f43f5e', soft: 'rgba(244,63,94,0.2)' },
  { id: 'pink', label: 'Quiet Pink', hex: '#ec4899', soft: 'rgba(236,72,153,0.2)' },
  { id: 'indigo', label: 'Deep Indigo', hex: '#6366f1', soft: 'rgba(99,102,241,0.2)' },
] as const;

export type AccentId = (typeof accentOptions)[number]['id'];
export type AccentOption = (typeof accentOptions)[number];

export const argusColorTokens = {
  appBackground: '#0f0f16',
  panel: '#12121a',
  panelSubtle: '#0f0f16',
  surface: '#1a1a26',
  surfaceRaised: '#151520',
  border: 'rgb(255 255 255 / 5%)',
  borderStrong: 'rgb(255 255 255 / 10%)',
  text: 'rgb(255 255 255 / 92%)',
  textMuted: 'rgb(255 255 255 / 45%)',
  danger: '#f43f5e',
  success: '#22c55e',
  accent: '#a855f7',
  accentHover: '#c084fc',
  accentSoft: 'rgb(168 85 247 / 20%)',
} as const;

export const argusSpaceTokens = {
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  6: '1.5rem',
  8: '2rem',
} as const;

export const argusRadiusTokens = {
  sm: '0.5rem',
  md: '0.75rem',
  lg: '1rem',
  xl: '1.5rem',
} as const;

export const argusShadowTokens = {
  panel: '0 25px 50px -12px rgb(0 0 0 / 50%)',
  accent: '0 18px 34px var(--argus-color-accent-soft)',
} as const;

export function isAccentId(value: string | null): value is AccentId {
  return accentOptions.some((option) => option.id === value);
}

export function getAccentById(id: AccentId): AccentOption {
  return accentOptions.find((option) => option.id === id) ?? accentOptions[0]!;
}
