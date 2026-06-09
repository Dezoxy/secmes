import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

interface ModalProps {
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  contentClassName?: string;
  closeOnBackdrop?: boolean;
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
  closeOnBackdrop = false,
  style,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className={joinClasses('fixed inset-0 z-50 flex', className)}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
      style={style}
    >
      <div
        className={joinClasses(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          contentClassName,
        )}
        onClick={(event) => {
          if (closeOnBackdrop) event.stopPropagation();
        }}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
