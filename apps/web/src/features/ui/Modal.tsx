import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSwipeBack } from './useSwipeBack';

interface ModalProps {
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  contentClassName?: string;
  closeOnBackdrop?: boolean;
  style?: CSSProperties;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  useSwipeBack(dialogRef, onClose, true);

  const trapFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (event.shiftKey) {
      if (document.activeElement === first || document.activeElement === dialogRef.current) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }, []);

  // Portal to <body> so the fixed-position overlay always covers the viewport, escaping any ancestor
  // that establishes a containing block (e.g. the glassy headers now use backdrop-filter, which would
  // otherwise re-anchor a nested fixed modal to that header and mis-position/clip it).
  return createPortal(
    <div
      ref={dialogRef}
      className={joinClasses('fixed inset-0 z-50 flex', className)}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={trapFocus}
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
    </div>,
    document.body,
  );
}
