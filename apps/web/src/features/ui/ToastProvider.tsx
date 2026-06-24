import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ToastContext, type ToastOptions, type ToastVariant } from './ToastContext';

interface ActiveToast {
  id: number;
  message: string;
  variant: ToastVariant;
  leaving: boolean;
}

export const DEFAULT_DURATION_MS = 2500;
export const EXIT_MS = 200; // keep in sync with the argus-toast-exit animation duration

const variantClass: Record<ToastVariant, string> = {
  info: 'border-white/10 bg-[#1a1a26] text-white',
  success: 'border-green-500/30 bg-[#13231b] text-green-200',
  error: 'border-red-500/30 bg-[#231417] text-red-200',
};

/**
 * App-wide transient feedback. Toasts overlay the UI (never shift layout), float bottom-center above
 * modals (z-60 > the z-50 Modal), auto-dismiss, and are announced via an aria-live region. Trigger with
 * `useToast().toast(message, { variant })`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const idRef = useRef(0);
  // id -> the currently-pending timer for that toast (auto-dismiss, then the post-exit removal).
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    // Cancel the pending auto-dismiss (or a stale exit timer) and no-op if the toast is already leaving —
    // robust once a manual close button can race the auto-dismiss.
    clearTimeout(timers.current.get(id));
    setToasts((prev) => prev.map((t) => (t.id === id && !t.leaving ? { ...t, leaving: true } : t)));
    const finish = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, EXIT_MS);
    timers.current.set(id, finish);
  }, []);

  const toast = useCallback(
    (message: string, options?: ToastOptions) => {
      const id = (idRef.current += 1);
      const variant = options?.variant ?? 'info';
      const duration = options?.durationMs ?? DEFAULT_DURATION_MS;
      setToasts((prev) => [...prev, { id, message, variant, leaving: false }]);
      const auto = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, auto);
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Portal to <body> so the z-[60] toast layer sits ABOVE modals — which also portal to <body>
          at z-50. Without this the toasts render inside #root (now position:fixed) and a full-screen
          modal portaled to body would cover them, hiding feedback shown while a modal is open. */}
      {createPortal(
        <div
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4"
          role="status"
          aria-live="polite"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              aria-atomic="true"
              className={`pointer-events-auto max-w-[90vw] rounded-xl border px-4 py-2.5 text-sm shadow-lg shadow-black/40 ${
                variantClass[t.variant]
              } ${t.leaving ? 'argus-toast-exit' : 'argus-toast-enter'}`}
            >
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
