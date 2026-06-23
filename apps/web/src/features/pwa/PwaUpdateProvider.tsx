import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// VitePWA's virtual register dynamically imports workbox-window for prompt-mode updates.
import { registerSW } from 'virtual:pwa-register';
import {
  PwaUpdateContextProvider,
  type PwaUpdateContextValue,
  type PwaUpdateStatus,
} from './PwaUpdateContext';

const SW_UPDATE_FETCH_HEADERS = {
  'cache-control': 'no-cache',
} as const;
const BACKGROUND_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEV_UPDATE_PREVIEW_PARAM = 'previewPwaUpdate';

interface PwaUpdateProviderProps {
  children: ReactNode;
}

export function PwaUpdateProvider({ children }: PwaUpdateProviderProps) {
  const updateServiceWorker = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const serviceWorkerUrl = useRef<string | null>(null);
  const [devUpdatePreview, setDevUpdatePreview] = useState(isDevUpdatePreviewEnabled);
  const [status, setStatus] = useState<PwaUpdateStatus>(() =>
    isDevUpdatePreviewEnabled() ? 'available' : supportsServiceWorkers() ? 'idle' : 'unsupported',
  );
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const newVersionFetched = useRef(false);

  const checkForWaitingUpdate = useCallback(async (options?: { silent?: boolean }) => {
    if (!supportsServiceWorkers()) {
      if (!options?.silent) setStatus('unsupported');
      return;
    }

    if (!options?.silent) {
      setStatus('checking');
      setLastCheckedAt(new Date());
    }

    try {
      const nextRegistration =
        registration.current ?? (await navigator.serviceWorker.getRegistration());
      registration.current = nextRegistration ?? null;

      if (!nextRegistration) {
        if (!options?.silent) setStatus('unsupported');
        return;
      }

      const swUrl = serviceWorkerUrl.current;
      if (swUrl) {
        const response = await fetch(swUrl, {
          cache: 'no-store',
          headers: SW_UPDATE_FETCH_HEADERS,
        });
        if (!response.ok) {
          if (!options?.silent) setStatus('error');
          return;
        }
      }

      await nextRegistration.update();
      if (nextRegistration.waiting) {
        setStatus('available');
        return;
      }

      if (!nextRegistration.installing && !options?.silent) {
        setStatus('up-to-date');
      }
    } catch {
      if (!options?.silent) setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!supportsServiceWorkers()) {
      setStatus('unsupported');
      return;
    }

    updateServiceWorker.current = registerSW({
      immediate: true,
      onNeedRefresh() {
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

  useEffect(() => {
    if (!supportsServiceWorkers()) return;

    const checkWhenActive = () => {
      if (document.visibilityState !== 'visible') return;
      void checkForWaitingUpdate({ silent: true });
    };

    const interval = window.setInterval(checkWhenActive, BACKGROUND_UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener('focus', checkWhenActive);
    window.addEventListener('online', checkWhenActive);
    document.addEventListener('visibilitychange', checkWhenActive);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', checkWhenActive);
      window.removeEventListener('online', checkWhenActive);
      document.removeEventListener('visibilitychange', checkWhenActive);
    };
  }, [checkForWaitingUpdate]);

  useEffect(() => {
    if (status !== 'available' || newVersionFetched.current) return;
    newVersionFetched.current = true;
    fetch('/version.json', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          'version' in data &&
          typeof (data as { version: unknown }).version === 'string'
        ) {
          setNewVersion((data as { version: string }).version);
        }
      })
      .catch(() => undefined);
  }, [status]);

  const value = useMemo<PwaUpdateContextValue>(() => {
    const updateReady = !dismissed && (devUpdatePreview || status === 'available');

    return {
      canCheckForUpdate: status !== 'unsupported',
      updateReady,
      status,
      lastCheckedAt,
      newVersion,
      dialogOpen,
      checkForUpdate: () => checkForWaitingUpdate(),
      applyUpdate: async () => {
        if (devUpdatePreview) {
          clearDevUpdatePreviewUrl();
          setDevUpdatePreview(false);
          setStatus(supportsServiceWorkers() ? 'idle' : 'unsupported');
          return;
        }

        if (!updateServiceWorker.current) return;
        await updateServiceWorker.current(true);
      },
      dismissUpdate: () => setDismissed(true),
      openUpdateDialog: () => setDialogOpen(true),
      closeUpdateDialog: () => setDialogOpen(false),
    };
  }, [
    checkForWaitingUpdate,
    devUpdatePreview,
    dialogOpen,
    dismissed,
    lastCheckedAt,
    newVersion,
    status,
  ]);

  return <PwaUpdateContextProvider value={value}>{children}</PwaUpdateContextProvider>;
}

function isDevUpdatePreviewEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get(DEV_UPDATE_PREVIEW_PARAM) === '1'
  );
}

function clearDevUpdatePreviewUrl(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  url.searchParams.delete(DEV_UPDATE_PREVIEW_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

function supportsServiceWorkers(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}
