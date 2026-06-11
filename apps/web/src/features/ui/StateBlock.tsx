import type { AriaRole, ReactNode } from 'react';
import { AlertTriangle, Inbox, Info, Loader2, WifiOff, type LucideIcon } from 'lucide-react';
import type { MessageSocketStatus } from '../../lib/ws';
import { toSafeUiError } from '../../lib/safe-ui-error';

interface StateBlockProps {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
  role?: AriaRole;
  ariaLive?: 'off' | 'polite' | 'assertive';
  variant?: 'info' | 'loading' | 'empty' | 'error' | 'offline';
}

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function variantClass(variant: NonNullable<StateBlockProps['variant']>): string {
  if (variant === 'error') {
    return 'border-rose-400/20 bg-rose-500/[0.06]';
  }
  if (variant === 'offline') {
    return 'border-amber-400/20 bg-amber-500/[0.06]';
  }
  if (variant === 'loading') {
    return 'border-purple-400/15 bg-purple-500/[0.04]';
  }
  return 'border-white/10 bg-white/[0.02]';
}

function iconClass(variant: NonNullable<StateBlockProps['variant']>): string {
  if (variant === 'error') return 'text-rose-300';
  if (variant === 'offline') return 'text-amber-300';
  if (variant === 'empty') return 'text-white/60';
  return 'text-purple-300';
}

export function StateBlock({
  icon,
  title,
  children,
  className,
  compact = false,
  role,
  ariaLive,
  variant = 'info',
}: StateBlockProps) {
  const Icon = icon ?? Info;

  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={joinClasses(
        'rounded-xl border border-dashed',
        variantClass(variant),
        compact ? 'p-3' : 'p-4',
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
        <Icon
          className={joinClasses(
            'h-4 w-4',
            iconClass(variant),
            variant === 'loading' && 'animate-spin',
          )}
        />
        {title}
      </div>
      {children && <div className="text-sm leading-6 text-white/60">{children}</div>}
    </div>
  );
}

export function LoadingState({
  title = 'Loading',
  children = 'This should only take a moment.',
  className,
  compact,
}: Pick<StateBlockProps, 'title' | 'children' | 'className' | 'compact'>) {
  return (
    <StateBlock
      icon={Loader2}
      title={title}
      className={className}
      compact={compact}
      role="status"
      ariaLive="polite"
      variant="loading"
    >
      {children}
    </StateBlock>
  );
}

export function EmptyState({
  title,
  children,
  className,
  compact,
  icon = Inbox,
}: Pick<StateBlockProps, 'title' | 'children' | 'className' | 'compact' | 'icon'>) {
  return (
    <StateBlock icon={icon} title={title} className={className} compact={compact} variant="empty">
      {children}
    </StateBlock>
  );
}

export function ErrorState({
  error,
  title,
  message,
  className,
  compact,
}: {
  error?: unknown;
  title?: string;
  message?: string;
  className?: string;
  compact?: boolean;
}) {
  const safe = toSafeUiError(error, { title, message });
  const metadata = safe.status ? `Status ${safe.status}` : safe.kind;

  return (
    <StateBlock
      icon={AlertTriangle}
      title={safe.title}
      className={className}
      compact={compact}
      role="alert"
      ariaLive="polite"
      variant="error"
    >
      <p>{safe.message}</p>
      {metadata && (
        <p className="mt-1 text-xs uppercase tracking-[0.08em] text-white/60">{metadata}</p>
      )}
    </StateBlock>
  );
}

function connectionCopy(status: MessageSocketStatus): { title: string; message: string } | null {
  if (status === 'connected') return null;
  if (status === 'connecting') {
    return {
      title: 'Connecting',
      message: 'Live messages will appear when the secure realtime channel is ready.',
    };
  }
  if (status === 'reconnecting') {
    return {
      title: 'Reconnecting',
      message: 'New messages may be delayed. The app is retrying automatically.',
    };
  }
  return {
    title: 'Offline',
    message: 'Live messages are unavailable right now. You can retry when the service is back.',
  };
}

export function ReconnectBanner({
  status,
  className,
}: {
  status: MessageSocketStatus;
  className?: string;
}) {
  const copy = connectionCopy(status);
  if (!copy) return null;

  return (
    <StateBlock
      icon={WifiOff}
      title={copy.title}
      className={className}
      compact
      role="status"
      ariaLive="polite"
      variant="offline"
    >
      {copy.message}
    </StateBlock>
  );
}
