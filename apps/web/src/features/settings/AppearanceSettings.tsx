import { Check } from 'lucide-react';
import { accentOptions, getAccentById, type AccentId, type AccentOption } from '../ui';

export const FONT_SIZE_LEVELS = Array.from({ length: 10 }, (_, index) => index + 1);

interface AppearanceSettingsProps {
  accentId: AccentId;
  fontSizeLevel: number;
  onAccentIdChange: (accentId: AccentId) => void;
  onFontSizeLevelChange: (fontSizeLevel: number) => void;
}

function FontSizePicker({
  value,
  accent,
  onChange,
}: {
  value: number;
  accent: AccentOption;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">Font size</p>
          <p className="mt-0.5 text-xs text-white/40">Level {value} of 10</p>
        </div>
        <span className="text-lg font-semibold text-white" style={{ color: accent.hex }}>
          Aa
        </span>
      </div>

      <input
        type="range"
        min={1}
        max={10}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label="Font size"
        className="h-6 w-full cursor-pointer"
        style={{ accentColor: accent.hex }}
      />

      <div className="px-1">
        <div className="grid grid-cols-10 gap-1">
          {FONT_SIZE_LEVELS.map((level) => (
            <span
              key={level}
              className="mx-auto h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: level <= value ? accent.hex : 'rgba(255,255,255,0.2)' }}
            />
          ))}
        </div>
      </div>

      <div className="mt-1 flex justify-between text-[11px] font-medium uppercase tracking-[0.08em] text-white/35">
        <span>Minimum</span>
        <span>Maximum</span>
      </div>
    </div>
  );
}

export function AppearanceSettings({
  accentId,
  fontSizeLevel,
  onAccentIdChange,
  onFontSizeLevelChange,
}: AppearanceSettingsProps) {
  const accent = getAccentById(accentId);

  return (
    <div className="space-y-3">
      <FontSizePicker value={fontSizeLevel} accent={accent} onChange={onFontSizeLevelChange} />
      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-white">Accent colour</p>
            <p className="mt-0.5 text-xs text-white/40">
              Pick a dark-mode accent that matches the current Argus contrast.
            </p>
          </div>
          <span
            className="h-8 w-8 shrink-0 rounded-full ring-2 ring-white/15"
            style={{ backgroundColor: accent.hex, boxShadow: `0 0 24px ${accent.soft}` }}
          />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {accentOptions.map((option) => {
            const selected = option.id === accentId;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onAccentIdChange(option.id)}
                className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'border-white/20 bg-white/[0.06] text-white'
                    : 'border-white/5 bg-black/10 text-white/55 hover:border-white/15 hover:text-white'
                }`}
                aria-pressed={selected}
              >
                <span
                  className="h-5 w-5 shrink-0 rounded-full ring-1 ring-white/20"
                  style={{ backgroundColor: option.hex }}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && <Check className="h-4 w-4 shrink-0 text-white/70" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
