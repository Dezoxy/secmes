import type { ReactNode } from 'react';

interface SettingsRowProps {
  title: string;
  value: string;
  badge?: string;
  enabled?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}

const rowClass =
  'flex w-full items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-left';
const interactiveClass =
  'transition-colors hover:border-purple-500/30 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a]';

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function Trailing({ badge, enabled, trailing }: SettingsRowProps) {
  if (trailing) return trailing;
  if (badge) {
    return (
      <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-white/60">
        {badge}
      </span>
    );
  }
  return (
    <span
      className={`h-6 w-10 rounded-full border p-0.5 transition-colors ${
        enabled ? 'border-purple-400/40 bg-purple-500/30' : 'border-white/10 bg-white/5'
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white/50 transition-transform ${
          enabled ? 'translate-x-4' : ''
        }`}
      />
    </span>
  );
}

export function SettingsRow(props: SettingsRowProps) {
  const content = (
    <>
      <div>
        <p className="text-sm font-medium text-white">{props.title}</p>
        <p className="mt-0.5 text-xs text-white/60">{props.value}</p>
      </div>
      <Trailing {...props} />
    </>
  );

  if (props.onClick) {
    const isSwitch = props.enabled !== undefined && !props.badge && !props.trailing;

    return (
      <button
        type="button"
        role={isSwitch ? 'switch' : undefined}
        aria-checked={isSwitch ? props.enabled : undefined}
        disabled={props.disabled}
        onClick={props.onClick}
        className={joinClasses(
          rowClass,
          props.disabled ? 'opacity-60 cursor-not-allowed' : interactiveClass,
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={rowClass}>{content}</div>;
}
