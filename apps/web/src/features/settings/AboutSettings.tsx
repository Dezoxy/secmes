import { useEffect, useState } from 'react';
import { ServiceInfoSchema } from '@argus/contracts';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { requestJson, type ApiResult } from '../../lib/api-client';
import { releaseNotes } from '../../lib/release-notes';

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

export function AboutSettings() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('offline');

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

  return (
    <div className="flex min-h-[calc(90vh-8rem)] flex-col sm:min-h-[calc(82vh-8rem)]">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="text-sm font-medium text-white">Backend status</span>
        <span className={`text-sm font-medium ${online ? 'text-green-400' : 'text-white/45'}`}>
          {statusLabel(backendStatus)}
        </span>
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
