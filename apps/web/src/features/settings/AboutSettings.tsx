import { useEffect, useRef, useState, type UIEvent } from 'react';
import { ServiceInfoSchema } from '@argus/contracts';
import { RefreshCw } from 'lucide-react';
import { requestJson, type ApiResult } from '../../lib/api-client';
import { releaseNotes } from '../../lib/release-notes';
import { usePwaUpdate, type PwaUpdateStatus } from '../pwa/PwaUpdateContext';

type BackendStatus = 'online' | 'offline';

interface ScrollThumbMetrics {
  height: number;
  offset: number;
  scrollable: boolean;
}

const hiddenScrollThumb: ScrollThumbMetrics = { height: 0, offset: 0, scrollable: false };

function backendStatusFromResult(result: ApiResult<unknown>): BackendStatus {
  return result.ok ? 'online' : 'offline';
}

export async function fetchBackendStatus(fetcher?: typeof fetch): Promise<BackendStatus> {
  try {
    const result = await requestJson({
      path: '/',
      responseSchema: ServiceInfoSchema,
      fetcher,
    });
    return backendStatusFromResult(result);
  } catch {
    return 'offline';
  }
}

function statusLabel(status: BackendStatus): 'Online' | 'Offline' {
  return status === 'online' ? 'Online' : 'Offline';
}

function updateStatusLabel(status: PwaUpdateStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking';
    case 'available':
      return 'Ready';
    case 'up-to-date':
      return 'Current';
    case 'error':
      return 'Check failed';
    case 'unsupported':
      return 'Unavailable';
    case 'idle':
      return 'Manual';
  }
}

export function AboutSettings() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('offline');
  const releaseNotesRef = useRef<HTMLElement | null>(null);
  const scrollHideTimerRef = useRef<number | undefined>(undefined);
  const [scrollThumb, setScrollThumb] = useState<ScrollThumbMetrics>(hiddenScrollThumb);
  const [scrollThumbVisible, setScrollThumbVisible] = useState(false);
  const {
    canCheckForUpdate,
    updateReady,
    status: updateStatus,
    checkForUpdate,
    applyUpdate,
  } = usePwaUpdate();

  useEffect(() => {
    let cancelled = false;
    void fetchBackendStatus().then((nextStatus) => {
      if (!cancelled) setBackendStatus(nextStatus);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const online = backendStatus === 'online';
  const checkingForUpdate = updateStatus === 'checking';

  function updateScrollThumb(node: HTMLElement): ScrollThumbMetrics {
    const trackHeight = Math.max(0, node.clientHeight - 16);
    const scrollable = node.scrollHeight > node.clientHeight + 1 && trackHeight > 0;
    if (!scrollable) {
      setScrollThumb(hiddenScrollThumb);
      return hiddenScrollThumb;
    }

    const thumbHeight = Math.max(28, (node.clientHeight / node.scrollHeight) * trackHeight);
    const maxThumbOffset = Math.max(0, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, node.scrollHeight - node.clientHeight);
    const offset = (node.scrollTop / maxScroll) * maxThumbOffset;
    const nextMetrics = { height: thumbHeight, offset, scrollable };
    setScrollThumb(nextMetrics);
    return nextMetrics;
  }

  function showScrollThumb(node: HTMLElement): void {
    const nextMetrics = updateScrollThumb(node);
    if (!nextMetrics.scrollable) return;

    setScrollThumbVisible(true);
    if (scrollHideTimerRef.current !== undefined) window.clearTimeout(scrollHideTimerRef.current);
    scrollHideTimerRef.current = window.setTimeout(() => {
      setScrollThumbVisible(false);
    }, 700);
  }

  function handleReleaseNotesScroll(event: UIEvent<HTMLElement>): void {
    showScrollThumb(event.currentTarget);
  }

  useEffect(() => {
    const node = releaseNotesRef.current;
    if (!node) return undefined;

    updateScrollThumb(node);

    function handleResize(): void {
      if (releaseNotesRef.current) updateScrollThumb(releaseNotesRef.current);
    }

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (scrollHideTimerRef.current !== undefined) window.clearTimeout(scrollHideTimerRef.current);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="text-sm font-medium text-white">Backend status</span>
        <span className={`text-sm font-medium ${online ? 'text-green-400' : 'text-white/60'}`}>
          {statusLabel(backendStatus)}
        </span>
      </div>

      <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">App update</p>
            <p className="mt-0.5 text-xs leading-relaxed text-white/60">
              {updateReady
                ? 'A new app shell is ready. Restart when your current work is saved.'
                : 'Checks the installed PWA shell for a newer frontend release.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-xs font-medium text-white/60 sm:inline">
              {updateStatusLabel(updateStatus)}
            </span>
            <button
              type="button"
              onClick={() => void (updateReady ? applyUpdate() : checkForUpdate())}
              disabled={!canCheckForUpdate || checkingForUpdate}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-white/65 transition-colors hover:border-purple-400/40 hover:text-white disabled:cursor-not-allowed disabled:text-white/25"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checkingForUpdate ? 'animate-spin' : ''}`} />
              {updateReady ? 'Restart' : checkingForUpdate ? 'Checking' : 'Check'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-white/60">
          Android, iOS, iPadOS, macOS, and desktop browsers can install Argus as a PWA when served
          over HTTPS. Some iOS metadata changes can still require removing and adding it again.
        </p>
      </div>

      <div className="relative mt-3 min-h-0 w-full flex-1">
        <section
          ref={releaseNotesRef}
          aria-label="Release notes"
          onScroll={handleReleaseNotesScroll}
          className="h-full min-h-0 w-full overscroll-contain overflow-y-auto rounded-xl border border-white/5 bg-white/[0.025] px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <h4 className="text-sm font-medium text-white/75">Release notes</h4>
          <div className="mt-3 space-y-4">
            {releaseNotes.map((note) => (
              <article key={`${note.version}-${note.title}`} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-medium text-white/65">{note.version}</p>
                  <p className="truncate text-xs text-white/60">{note.title}</p>
                </div>
                <ul className="space-y-1 pl-4 text-xs leading-5 text-white/60">
                  {note.items.map((item) => (
                    <li key={item} className="list-disc">
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
        {scrollThumb.scrollable && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute bottom-2 right-2 top-2 w-1.5 rounded-full bg-white/[0.04] transition-opacity duration-200 ${
              scrollThumbVisible ? 'opacity-100' : 'opacity-0'
            }`}
            data-testid="release-notes-scrollbar"
          >
            <span
              className="absolute left-0 w-full rounded-full bg-white/45 shadow-[0_0_10px_rgba(168,85,247,0.3)]"
              style={{
                height: `${scrollThumb.height}px`,
                transform: `translateY(${scrollThumb.offset}px)`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
