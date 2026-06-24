import { useEffect, useState } from 'react';
import { ServiceInfoSchema } from '@argus/contracts';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { requestJson, type ApiResult } from '../../lib/api-client';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { releaseNotes } from '../../lib/release-notes';
import { usePwaUpdate, type PwaUpdateStatus } from '../pwa/PwaUpdateContext';

type BackendStatus = 'online' | 'offline';

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
  const {
    canCheckForUpdate,
    updateReady,
    status: updateStatus,
    checkForUpdate,
    openUpdateDialog,
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

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="text-sm font-medium text-white">Version</span>
        <span className="text-sm font-medium text-white/60">{APP_VERSION_TAG}</span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="text-sm font-medium text-white">Backend status</span>
        <span className={`text-sm font-medium ${online ? 'text-green-400' : 'text-white/60'}`}>
          {statusLabel(backendStatus)}
        </span>
      </div>

      <a
        href="/transparency"
        className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 transition-colors hover:border-white/10 hover:bg-white/[0.05]"
      >
        <span className="text-sm font-medium text-white">Security &amp; transparency</span>
        <ExternalLink className="h-4 w-4 shrink-0 text-white/40" />
      </a>

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
              onClick={() => void (updateReady ? openUpdateDialog() : checkForUpdate())}
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

      <section
        aria-label="Release notes"
        className="mt-3 rounded-xl border border-white/5 bg-white/[0.025] px-4 py-3"
      >
        <h4 className="text-sm font-medium text-white/75">Release notes</h4>
        <div className="mt-3 space-y-4">
          {releaseNotes.map((note) => (
            <article key={`${note.version}-${note.title}`} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium text-white/65">{note.version}</p>
                <p className="truncate text-xs text-white/60">{note.title}</p>
              </div>
              <div className="space-y-2">
                {note.groups.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-white/45">
                      {group.label}
                    </p>
                    <ul className="space-y-1 pl-4 text-xs leading-5 text-white/60">
                      {group.items.map((item) => (
                        <li key={item} className="list-disc">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {note.overflowNote && (
                  <p className="pl-4 text-xs leading-5 text-white/45">{note.overflowNote}</p>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
