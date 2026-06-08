import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Download, KeyRound, Loader2, X } from 'lucide-react';
import {
  RECOVERY_IDENTITY,
  exportRecovery,
  recoveryIsSetUp,
  setUpRecovery,
} from '../../lib/recovery';
import { useAuth } from '../auth/AuthContext';

const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20';
const PRIMARY =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:bg-purple-500/50 disabled:shadow-none';

/** Save a string as a downloaded file (the sealed recovery artifact — opaque, the server never sees it). */
function downloadFile(name: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface RecoveryPanelProps {
  embedded?: boolean;
  onClose?: () => void;
}

export function RecoveryPanel({ embedded = false, onClose }: RecoveryPanelProps) {
  const { profile } = useAuth();
  // Back up the SIGNED-IN account's device under the same identity the unlock gate sealed it with.
  // RECOVERY_IDENTITY is only the demo fallback when there is no real account.
  const identity = profile?.userId ?? RECOVERY_IDENTITY;
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void recoveryIsSetUp()
      .then(setSetUp)
      .catch(() => setSetUp(false));
  }, []);

  const backUp = async () => {
    setError(null);
    setDone(null);
    if (passphrase.length < 8) {
      setError('Use a passphrase of at least 8 characters.');
      return;
    }
    if (setUp !== true && passphrase !== confirm) {
      setError('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      const artifact =
        setUp === true
          ? await exportRecovery(identity, passphrase)
          : await setUpRecovery(identity, passphrase);
      downloadFile('argus-recovery.json', artifact);
      setSetUp(true);
      setDone(
        'Recovery file downloaded. Store it somewhere safe — you need it and this passphrase to recover.',
      );
      setPassphrase('');
      setConfirm('');
    } catch {
      setError('Could not create the recovery file — wrong passphrase for an existing device?');
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20">
            <KeyRound className="h-4 w-4 text-purple-400" />
          </div>
          <h2 className="text-lg font-semibold text-white">Account recovery</h2>
        </div>
        {!embedded && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/5 hover:text-white/80"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200/80">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <span>
          Your messages are end-to-end encrypted. If you lose this device <strong>without</strong> a
          recovery file and its passphrase, your account cannot be recovered — not even by us.
        </span>
      </div>

      {setUp !== null && (
        <div
          className={`mb-4 flex items-center gap-2 text-sm ${setUp ? 'text-green-400' : 'text-white/40'}`}
        >
          {setUp ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {setUp ? 'Recovery is set up on this device.' : 'Recovery is not set up yet.'}
        </div>
      )}

      <div className="space-y-3">
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Recovery passphrase"
          autoComplete="new-password"
          className={INPUT}
        />
        {setUp !== true && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm passphrase"
            autoComplete="new-password"
            className={INPUT}
          />
        )}
        <button type="button" onClick={() => void backUp()} disabled={busy} className={PRIMARY}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {setUp === true ? 'Download recovery file' : 'Create & download recovery file'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {done && <p className="mt-3 text-sm text-green-400">{done}</p>}
    </>
  );

  if (embedded) {
    return <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">{content}</div>;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Account recovery"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50">
        {content}
      </div>
    </div>
  );
}
