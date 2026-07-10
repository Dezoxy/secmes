import { useEffect } from 'react';
import { ToastProvider, useToast } from '@argus/web';

// Toasts only appear via the imperative `toast()` call from useToast() — there's no static "open"
// prop to set. Each story triggers one on mount so the card shows the real rendered bubble instead
// of an empty ToastProvider (which, with no toast pushed, renders nothing but its children).
function TriggerOnMount({
  message,
  variant,
}: {
  message: string;
  variant?: 'info' | 'success' | 'error';
}) {
  const { toast } = useToast();
  // Intentionally fires once on mount — `toast` is stable across ToastProvider's lifetime and
  // `message`/`variant` are per-story constants, so re-running this on every render would just
  // requeue the same toast.
  useEffect(() => {
    toast(message, { variant, durationMs: 60_000 });
  }, [message, toast, variant]);
  return <div style={{ width: 360, height: 80 }} />;
}

// Ported message copy from real call sites (features/settings/DisplayNameEditor.tsx,
// features/pwa/PushReconciler.tsx).
export function Success() {
  return (
    <ToastProvider>
      <TriggerOnMount message="Saved" variant="success" />
    </ToastProvider>
  );
}

export function ErrorVariant() {
  return (
    <ToastProvider>
      <TriggerOnMount message="This display name is already taken" variant="error" />
    </ToastProvider>
  );
}

export function Info() {
  return (
    <ToastProvider>
      <TriggerOnMount message="Voice and video calls are coming soon" />
    </ToastProvider>
  );
}
