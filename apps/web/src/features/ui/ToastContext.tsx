import { createContext, useContext } from 'react';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms (default 2500). */
  durationMs?: number;
}

export interface ToastContextValue {
  /** Show a transient, auto-dismissing toast (bottom-center). */
  toast: (message: string, options?: ToastOptions) => void;
}

// Noop default so `useToast()` is safe with no provider mounted (SSR, unit tests) — mirrors the
// PwaUpdate context pattern. The real implementation is supplied by <ToastProvider>.
export const defaultToastContext: ToastContextValue = {
  toast: () => undefined,
};

export const ToastContext = createContext<ToastContextValue>(defaultToastContext);

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
