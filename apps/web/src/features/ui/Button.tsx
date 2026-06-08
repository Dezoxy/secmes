import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'subtle' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a] disabled:cursor-not-allowed disabled:opacity-45';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-purple-500 text-white shadow-lg shadow-purple-500/20 hover:bg-purple-400 disabled:hover:bg-purple-500',
  subtle:
    'border border-white/10 bg-white/[0.03] text-white/70 hover:border-purple-500/40 hover:text-white',
  ghost: 'text-white/55 hover:bg-white/[0.05] hover:text-white',
  danger: 'bg-rose-500/15 text-rose-200 hover:bg-rose-500/20',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-4 py-2.5 text-sm',
};

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel = 'Loading',
  disabled,
  children,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={joinClasses(base, variants[variant], sizes[size], className)}
    >
      {loading ? (
        <>
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
