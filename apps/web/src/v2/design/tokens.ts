export const v2Tokens = {
  colors: {
    app: '#0b0d10',
    panel: '#111418',
    panelSoft: '#151a20',
    line: '#232830',
    lineSoft: 'rgb(255 255 255 / 7%)',
    text: 'rgb(255 255 255 / 92%)',
    textMuted: 'rgb(255 255 255 / 58%)',
    textFaint: 'rgb(255 255 255 / 36%)',
    accent: '#2dd4bf',
    verified: '#57d68d',
    warning: '#f2b84b',
    danger: '#f0526b',
  },
  radius: {
    control: '0.625rem',
    panel: '0.75rem',
    shell: '1rem',
  },
} as const;

export const v2ClassNames = {
  page: 'min-h-screen bg-[#0b0d10] text-white antialiased',
  panel: 'border border-white/[0.07] bg-[#111418]',
  panelSoft: 'border border-white/[0.06] bg-[#151a20]',
  muted: 'text-white/58',
  faint: 'text-white/36',
  accentText: 'text-teal-300',
  verifiedText: 'text-emerald-300',
  focus:
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0d10]',
} as const;
