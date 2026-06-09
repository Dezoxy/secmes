import { RefreshCw, X } from 'lucide-react';
import { usePwaUpdate } from './PwaUpdateContext';

export function PwaUpdatePrompt() {
  const { showUpdatePrompt, applyUpdate, dismissUpdate } = usePwaUpdate();
  if (!showUpdatePrompt) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-[70] mx-auto max-w-md rounded-2xl border border-purple-400/30 bg-[#151520]/95 p-4 shadow-2xl shadow-black/60 backdrop-blur-xl sm:left-auto sm:right-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-purple-500/20">
          <RefreshCw className="h-4 w-4 text-purple-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">Update available</p>
          <p className="mt-1 text-xs leading-relaxed text-white/50">
            Restart Argus to load the latest installed app shell.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void applyUpdate()}
              className="rounded-lg bg-purple-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-purple-500/25 transition-colors hover:bg-purple-400"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={dismissUpdate}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/55 transition-colors hover:border-white/20 hover:text-white"
            >
              Later
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismissUpdate}
          className="rounded-lg p-1 text-white/35 transition-colors hover:bg-white/5 hover:text-white/75"
          aria-label="Dismiss update prompt"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
