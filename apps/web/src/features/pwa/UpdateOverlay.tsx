import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { usePwaUpdate } from './PwaUpdateContext';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { modalPanelExitMotion } from '../ui';

export function UpdateOverlay() {
  const { updateReady, applyUpdate, newVersion, dialogOpen, openUpdateDialog, closeUpdateDialog } =
    usePwaUpdate();
  const [applying, setApplying] = useState(false);
  const [closing, setClosing] = useState(false);

  if (!updateReady) return null;

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      closeUpdateDialog();
    }, 220);
  };

  if (!dialogOpen) {
    return (
      <div
        className="fixed right-4 top-1/2 z-50 -translate-y-1/2 sm:right-6"
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={openUpdateDialog}
          aria-label="Update Argus"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-purple-400/40 bg-[#2b123d]/95 px-4 text-sm font-semibold text-white shadow-2xl shadow-black/35 backdrop-blur transition-all duration-200 hover:border-purple-300/70 hover:bg-[#37164f] active:scale-95"
        >
          <RefreshCw className="h-4 w-4" />
          Update
        </button>
      </div>
    );
  }

  const handleUpdate = async () => {
    setApplying(true);
    try {
      await applyUpdate();
    } catch {
      setApplying(false);
    }
  };

  return (
    <div className="fixed right-4 top-1/2 z-50 -translate-y-1/2 sm:right-6">
      <div
        role="dialog"
        aria-label="Update available"
        className={`w-72 rounded-2xl border border-purple-400/40 bg-[#2b123d]/95 p-4 shadow-2xl shadow-black/35 backdrop-blur sm:w-80 ${closing ? modalPanelExitMotion : 'argus-surface-enter'}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Update available</span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="rounded-md p-1 text-white/50 transition-colors hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 space-y-1.5 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-white/50">Running</span>
            <span className="font-mono font-medium text-white">{APP_VERSION_TAG}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/50">Update</span>
            {newVersion ? (
              <span className="font-mono font-medium text-purple-300">{newVersion}</span>
            ) : (
              <span className="animate-pulse font-mono text-white/30">fetching…</span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleUpdate()}
          disabled={applying}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-purple-400/40 bg-purple-600/30 px-4 py-2 text-sm font-semibold text-white transition-all hover:border-purple-300/70 hover:bg-purple-600/50 active:scale-95 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${applying ? 'animate-spin' : ''}`} />
          {applying ? 'Restarting…' : 'Update Argus'}
        </button>
      </div>
    </div>
  );
}
