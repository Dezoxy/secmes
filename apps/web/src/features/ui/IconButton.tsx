import type { ButtonHTMLAttributes, ReactNode } from 'react';

type IconButtonVariant = 'ghost' | 'subtle' | 'danger';
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  children: ReactNode;
}

const base =
  'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a] disabled:cursor-not-allowed disabled:opacity-45';

const variants: Record<IconButtonVariant, string> = {
  ghost: 'text-white/50 hover:bg-white/5 hover:text-white',
  subtle:
    'border border-white/10 bg-white/[0.03] text-white/60 hover:border-purple-500/40 hover:text-white',
  danger: 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200',
};

const sizes: Record<IconButtonSize, string> = {
  xs: 'p-0.5',
  sm: 'p-1.5',
  md: 'p-2',
  lg: 'p-2.5',
};

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function IconButton({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={joinClasses(base, variants[variant], sizes[size], className)}
    >
      {children}
    </button>
  );
}
