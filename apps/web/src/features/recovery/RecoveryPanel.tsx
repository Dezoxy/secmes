import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Cloud, Download, KeyRound, Loader2, Upload, X } from 'lucide-react';
import { formatDeviceIdentity } from '@argus/crypto';
import { RestoreCommittedError, restoreAndProvision } from '../../lib/device-restore';
import { fetchBackup, storeBackup } from '../../lib/api';
import {
  RECOVERY_IDENTITY,
  exportRecovery,
  peekArtifactIdentity,
  recoveryIsSetUp,
  restoreFromArtifact,
  setUpRecovery,
} from '../../lib/recovery';
import { useAuth } from '../auth/AuthContext';
import { useDevice } from '../device/DeviceContext';
import {
  MIN_RECOVERY_PASSPHRASE_LENGTH,
  backupDownloadMessage,
  getRecoveryPassphraseStrength,
  readRecoveryReminderDismissed,
  shouldUploadBackup,
  writeRecoveryReminderDismissed,
  type BackupUploadOutcome,
  type RecoveryPassphraseStrength,
} from './recovery-ux';

const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20';
const PRIMARY =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:bg-purple-500/50 disabled:shadow-none';
// Shared across the file-import and server-restore paths — both fail dominantly on a wrong passphrase
// (the file/blob is already chosen at this point), so one message covers both.
const RESTORE_FAILED_MESSAGE = 'Could not restore — check your passphrase and try again.';
const RECOVERY_STRENGTH_STEPS = [1, 2, 3, 4] as const;

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

function recoveryStrengthSegmentClass(
  active: boolean,
  score: RecoveryPassphraseStrength['score'],
): string {
  if (!active) return 'bg-white/10';
  if (score <= 1) return 'bg-red-400';
  if (score === 2) return 'bg-amber-400';
  if (score === 3) return 'bg-sky-400';
  return 'bg-green-400';
}

function PassphraseStrengthMeter({ strength }: { strength: RecoveryPassphraseStrength }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-white/60">Passphrase strength</span>
        <span className="text-white/60">{strength.label}</span>
      </div>
      <div
        role="meter"
        aria-label="Recovery passphrase strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={strength.score}
        aria-valuetext={`${strength.label}. ${strength.hint}`}
        className="grid grid-cols-4 gap-1.5"
      >
        {RECOVERY_STRENGTH_STEPS.map((step) => (
          <span
            key={step}
            className={`h-1.5 rounded-full transition-colors ${recoveryStrengthSegmentClass(
              step <= strength.score,
              strength.score,
            )}`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/60">{strength.hint}</p>
    </div>
  );
}

interface RecoveryPanelProps {
  embedded?: boolean;
  onClose?: () => void;
}

export function RecoveryPanel({ embedded = false, onClose }: RecoveryPanelProps) {
  const { profile } = useAuth();
  const device = useDevice();
  // Export uses the composite identity the keystore was sealed under (userId:deviceUuid).
  // RECOVERY_IDENTITY is only the demo fallback when no account or no device UUID is available.
  const exportIdentity =
    profile && device.deviceUuid
      ? formatDeviceIdentity(profile.userId, device.deviceUuid)
      : (profile?.userId ?? RECOVERY_IDENTITY);
  const [setUp, setSetUp] = useState<boolean | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Server-fetched artifact for the "Restore from server" path
  const [serverArtifact, setServerArtifact] = useState<string | null>(null);
  const [serverFetchState, setServerFetchState] = useState<
    'idle' | 'loading' | 'found' | 'not-found'
  >('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reminderDismissed, setReminderDismissed] = useState(() => readRecoveryReminderDismissed());
  const passphraseStrength = getRecoveryPassphraseStrength(passphrase);

  useEffect(() => {
    void recoveryIsSetUp()
      .then(setSetUp)
      .catch(() => setSetUp(false));
  }, []);

  const backUp = async () => {
    setError(null);
    setDone(null);
    if (passphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
      setError(`Use a passphrase of at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`);
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
          ? await exportRecovery(exportIdentity, passphrase)
          : await setUpRecovery(exportIdentity, passphrase);
      downloadFile('argus-recovery.json', artifact);
      // Server upload is a non-blocking safety-net (the downloaded file is the primary copy), but we
      // report the outcome honestly: claiming "saved to your account" when the upload failed would
      // leave the user trusting a server backup that does not exist. Gate on the profile (see
      // shouldUploadBackup — the artifact is sealed under profile.userId).
      let outcome: BackupUploadOutcome = 'local-only';
      if (shouldUploadBackup(Boolean(profile))) {
        outcome = await storeBackup(artifact).then(
          () => 'saved' as const,
          () => 'failed' as const,
        );
      }
      setSetUp(true);
      setDone(backupDownloadMessage(outcome));
      setPassphrase('');
      setConfirm('');
    } catch {
      setError('Could not create the recovery file — wrong passphrase for an existing device?');
    } finally {
      setBusy(false);
    }
  };

  const importRecoveryFile = async () => {
    setError(null);
    setDone(null);
    if (!file) {
      setError('Choose your recovery file.');
      return;
    }
    if (importPassphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
      setError(`Use a passphrase of at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      const artifactText = await file.text();
      const restoreIdentity = await peekArtifactIdentity(artifactText, importPassphrase);
      if (device.keystore) {
        await restoreAndProvision(device.keystore, restoreIdentity, artifactText, importPassphrase);
        setDone('Device restored — reloading…');
        window.location.reload();
      } else {
        await restoreFromArtifact(restoreIdentity, artifactText, importPassphrase);
        setSetUp(true);
        setDone('This device was restored from your recovery file.');
        setFile(null);
        setImportPassphrase('');
      }
    } catch (e) {
      if (e instanceof RestoreCommittedError) {
        window.location.reload();
        return;
      }
      setError(RESTORE_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  const fetchFromServer = async () => {
    setError(null);
    setDone(null);
    setServerFetchState('loading');
    try {
      const artifact = await fetchBackup();
      if (artifact === null) {
        setServerFetchState('not-found');
      } else {
        setServerArtifact(artifact);
        setServerFetchState('found');
      }
    } catch {
      setServerFetchState('idle');
      setError('Could not reach the server — check your connection and try again.');
    }
  };

  const restoreFromServer = async () => {
    if (!serverArtifact) return;
    setError(null);
    setDone(null);
    if (importPassphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
      setError(`Use a passphrase of at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      const restoreIdentity = await peekArtifactIdentity(serverArtifact, importPassphrase);
      if (device.keystore) {
        await restoreAndProvision(
          device.keystore,
          restoreIdentity,
          serverArtifact,
          importPassphrase,
        );
        setDone('Device restored — reloading…');
        window.location.reload();
      } else {
        await restoreFromArtifact(restoreIdentity, serverArtifact, importPassphrase);
        setSetUp(true);
        setDone('This device was restored from your server backup.');
        setServerArtifact(null);
        setServerFetchState('idle');
        setImportPassphrase('');
      }
    } catch (e) {
      if (e instanceof RestoreCommittedError) {
        window.location.reload();
        return;
      }
      setError(RESTORE_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  const dismissReminder = () => {
    writeRecoveryReminderDismissed(true);
    setReminderDismissed(true);
  };

  const showRecoveryReminder = setUp === false && !reminderDismissed;

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
            className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/5 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200/80">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <span>
          Argus recovery restores the encrypted messaging identity for future messages only. It does
          not restore past message history. If you lose this device <strong>without</strong> a
          recovery file and its passphrase, we cannot recover that messaging identity for you.
        </span>
      </div>

      {showRecoveryReminder && (
        <div className="mb-4 rounded-xl border border-purple-500/20 bg-purple-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-purple-300" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">
                Set up recovery before you rely on this device
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-white/55">
                Zitadel can restore sign-in only. This local recovery file restores your encrypted
                messaging identity for future messages; old message history is not recovered.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismissReminder}
            className="mt-3 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/65 transition-colors hover:border-purple-400/40 hover:text-white"
          >
            Dismiss reminder
          </button>
        </div>
      )}

      {setUp !== null && (
        <div
          className={`mb-4 flex items-center gap-2 text-sm ${setUp ? 'text-green-400' : 'text-white/60'}`}
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
          aria-label="Recovery passphrase"
          autoComplete="new-password"
          className={INPUT}
        />
        {setUp !== true && <PassphraseStrengthMeter strength={passphraseStrength} />}
        {setUp !== true && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm passphrase"
            aria-label="Confirm recovery passphrase"
            autoComplete="new-password"
            className={INPUT}
          />
        )}
        <button type="button" onClick={() => void backUp()} disabled={busy} className={PRIMARY}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {setUp === true ? 'Download recovery file' : 'Create & download recovery file'}
        </button>
      </div>

      <div className="mt-3 rounded-xl border border-white/5 bg-white/[0.025] p-3">
        <button
          type="button"
          onClick={() => {
            // Collapsing the section discards any fetched server artifact so a stale blob can't linger
            // into a later reopen (where serverFetchState would no longer be 'found').
            if (importOpen) {
              setServerArtifact(null);
              setServerFetchState('idle');
            }
            setImportOpen((open) => !open);
            setError(null);
            setDone(null);
          }}
          className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium text-white/75 transition-colors hover:text-white"
          aria-expanded={importOpen}
        >
          <span className="inline-flex items-center gap-2">
            <Upload aria-hidden="true" className="h-4 w-4 text-white/60" />
            Restore on this device
          </span>
          <span className="text-xs text-white/60">{importOpen ? 'Hide' : 'Advanced'}</span>
        </button>

        {importOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-relaxed text-white/60">
              Zitadel restores account access. This restores this browser&apos;s encrypted device
              state for future messages only; past message history is not recovered.
            </p>

            {/* Server restore — only shown when signed in */}
            {profile && serverFetchState !== 'found' && (
              <button
                type="button"
                onClick={() => void fetchFromServer()}
                disabled={serverFetchState === 'loading'}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2.5 text-sm font-medium text-white/70 transition-colors hover:border-purple-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {serverFetchState === 'loading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Cloud className="h-4 w-4" />
                )}
                {serverFetchState === 'not-found' ? 'No server backup found' : 'Fetch from server'}
              </button>
            )}

            {serverFetchState === 'found' && (
              <div className="flex items-center gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-300">
                <Check className="h-4 w-4 shrink-0" />
                Server backup found — enter your passphrase to restore.
              </div>
            )}

            {/* File picker — always available as fallback */}
            {serverFetchState !== 'found' && (
              <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-white/10 bg-[#1a1a26] px-4 py-3 text-sm text-white/60 transition-colors hover:border-purple-500/40">
                <Upload aria-hidden="true" className="h-4 w-4 shrink-0 text-white/60" />
                <span className="truncate">
                  {file ? file.name : 'Or choose your recovery file'}
                </span>
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}

            <input
              type="password"
              value={importPassphrase}
              onChange={(e) => setImportPassphrase(e.target.value)}
              placeholder="Recovery passphrase"
              aria-label="Recovery file passphrase"
              autoComplete="off"
              className={INPUT}
            />

            {serverFetchState === 'found' ? (
              <button
                type="button"
                onClick={() => void restoreFromServer()}
                disabled={busy || importPassphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH}
                className={PRIMARY}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Cloud className="h-4 w-4" />
                )}
                Restore from server
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void importRecoveryFile()}
                disabled={busy || !file || importPassphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH}
                className={PRIMARY}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Replace this device
              </button>
            )}
          </div>
        )}
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
