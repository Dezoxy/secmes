import { useEffect, type CSSProperties, type ReactNode } from 'react';

interface ModalProps {
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  contentClassName?: string;
  style?: CSSProperties;
}

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Modal({
  ariaLabel,
  children,
  onClose,
  className,
  contentClassName,
  style,
}: ModalProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className={joinClasses('fixed inset-0 z-50 flex', className)}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={style}
    >
      <div
        className={joinClasses(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          contentClassName,
        )}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
