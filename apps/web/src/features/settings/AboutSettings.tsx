import { useEffect, useState } from 'react';
import { ServiceInfoSchema } from '@argus/contracts';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { requestJson, type ApiResult } from '../../lib/api-client';

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

      <p className="mt-auto pb-1 pt-10 text-center text-xs font-medium text-white/30">
        {APP_VERSION_TAG}
      </p>
    </div>
  );
}
