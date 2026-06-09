import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { registerSW } from 'virtual:pwa-register';
import {
  PwaUpdateContextProvider,
  type PwaUpdateContextValue,
  type PwaUpdateStatus,
} from './PwaUpdateContext';

const SW_UPDATE_FETCH_HEADERS = {
  'cache-control': 'no-cache',
} as const;

interface PwaUpdateProviderProps {
  children: ReactNode;
}

export function PwaUpdateProvider({ children }: PwaUpdateProviderProps) {
  const updateServiceWorker = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const serviceWorkerUrl = useRef<string | null>(null);
  const [status, setStatus] = useState<PwaUpdateStatus>(() =>
    supportsServiceWorkers() ? 'idle' : 'unsupported',
  );
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [promptDismissed, setPromptDismissed] = useState(false);

  useEffect(() => {
    if (!supportsServiceWorkers()) {
      setStatus('unsupported');
      return;
    }

    updateServiceWorker.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        setPromptDismissed(false);
        setStatus('available');
      },
      onOfflineReady() {
        setStatus((current) => (current === 'unsupported' ? 'idle' : current));
      },
      onRegisteredSW(swUrl, nextRegistration) {
        serviceWorkerUrl.current = swUrl;
        registration.current = nextRegistration ?? null;
        setStatus((current) => (current === 'unsupported' ? 'idle' : current));
      },
      onRegisterError() {
        setStatus('error');
      },
    });
  }, []);

  const value = useMemo<PwaUpdateContextValue>(() => {
    const updateReady = status === 'available';

    return {
      canCheckForUpdate: status !== 'unsupported',
      updateReady,
      showUpdatePrompt: updateReady && !promptDismissed,
      status,
      lastCheckedAt,
      checkForUpdate: async () => {
        if (!supportsServiceWorkers()) {
          setStatus('unsupported');
          return;
        }

        setStatus('checking');
        setPromptDismissed(false);
        setLastCheckedAt(new Date());
        try {
          const nextRegistration =
            registration.current ?? (await navigator.serviceWorker.getRegistration());
          registration.current = nextRegistration ?? null;

          if (!nextRegistration) {
            setStatus('unsupported');
            return;
          }

          const swUrl = serviceWorkerUrl.current;
          if (swUrl) {
            const response = await fetch(swUrl, {
              cache: 'no-store',
              headers: SW_UPDATE_FETCH_HEADERS,
            });
            if (!response.ok) {
              setStatus('error');
              return;
            }
          }

          await nextRegistration.update();
          if (!nextRegistration.waiting && !nextRegistration.installing) {
            setStatus('up-to-date');
          }
        } catch {
          setStatus('error');
        }
      },
      applyUpdate: async () => {
        if (!updateServiceWorker.current) return;
        await updateServiceWorker.current(true);
      },
      dismissUpdate: () => {
        setPromptDismissed(true);
      },
    };
  }, [lastCheckedAt, promptDismissed, status]);

  return <PwaUpdateContextProvider value={value}>{children}</PwaUpdateContextProvider>;
}

function supportsServiceWorkers(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}
