import { useEffect, useState } from 'react';
import { ServiceInfoSchema } from '@argus/contracts';
import { RefreshCw } from 'lucide-react';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { requestJson, type ApiResult } from '../../lib/api-client';
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

  return (
    <div className="flex min-h-[calc(90vh-8rem)] flex-col sm:min-h-[calc(82vh-8rem)]">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="text-sm font-medium text-white">Backend status</span>
        <span className={`text-sm font-medium ${online ? 'text-green-400' : 'text-white/45'}`}>
          {statusLabel(backendStatus)}
        </span>
      </div>

      <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">App update</p>
            <p className="mt-0.5 text-xs leading-relaxed text-white/40">
              {updateReady
                ? 'A new app shell is ready. Restart when your current work is saved.'
                : 'Checks the installed PWA shell for a newer frontend release.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-xs font-medium text-white/35 sm:inline">
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
        <p className="mt-2 text-xs leading-relaxed text-white/30">
          On iPhone, app icon or Home Screen name changes may still require removing and adding the
          app again.
        </p>
      </div>

      <section
        aria-label="Release notes"
        className="mt-3 max-h-44 w-full overflow-y-auto rounded-xl border border-white/5 bg-white/[0.025] px-4 py-3"
      >
        <h4 className="text-sm font-medium text-white/75">Release notes</h4>
        <div className="mt-3 space-y-4">
          {releaseNotes.map((note) => (
            <article key={`${note.version}-${note.title}`} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium text-white/65">{note.version}</p>
                <p className="truncate text-xs text-white/35">{note.title}</p>
              </div>
              <ul className="space-y-1 pl-4 text-xs leading-5 text-white/45">
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

      <p className="mt-auto pb-1 pt-10 text-center text-xs font-medium text-white/30">
        {APP_VERSION_TAG}
      </p>
    </div>
  );
}
