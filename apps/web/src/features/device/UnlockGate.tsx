import { useState, type FormEvent, type ReactNode } from 'react';

import { Loader2, Lock, Upload, UserCog } from 'lucide-react';

import { useDevice } from './DeviceContext';

// Gates the chat on an unlocked MLS device. The device keys are sealed at rest under a passphrase
// (Argon2id + AES-GCM) — this prompts to unlock an existing device or set a passphrase on first run, then
// DeviceProvider provisions + publishes the KeyPackage pool. A RESTORE path (recovery file) is reachable
// here so a fresh-browser / lost-device user can recover before creating a throwaway device, and a
// SWITCH path handles a browser already holding a different account's device (single slot, v1). Demo mode
// short-circuits ('ready'). v1 UX: a local passcode gate (strength meter / timeout are follow-ups).
const MIN_PASSPHRASE = 8;

const CARD = 'w-full max-w-sm rounded-3xl bg-[#12121a] p-8 shadow-2xl shadow-black/50';
const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-3 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50';
const PRIMARY =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-3 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-40';
const LINK = 'w-full text-center text-xs text-white/60 transition-colors hover:text-white/90';

export function UnlockGate({ children }: { children: ReactNode }): ReactNode {
  const { status, error, unlock, restore, resetForNewAccount } = useDevice();
  const [mode, setMode] = useState<'default' | 'restore'>('default');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [file, setFile] = useState<File | null>(null);

  if (status === 'ready') return <>{children}</>;

  const creating = status === 'needs-create';
  const busy = status === 'unlocking' || status === 'loading';
  const mismatch = creating && confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;

  const submitDefault = (e: FormEvent): void => {
    e.preventDefault();
    const ok = passphrase.length >= MIN_PASSPHRASE && (!creating || passphrase === confirm);
    if (!busy && ok) void unlock(passphrase);
  };
  const submitRestore = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !file || passphrase.length < MIN_PASSPHRASE) return;
    await restore(await file.text(), passphrase);
  };

  const shell = (icon: ReactNode, title: string, subtitle: string, body: ReactNode): ReactNode => (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4">
      <div className={CARD}>
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-purple-500/20">
            {icon}
          </div>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="mt-1 text-sm text-white/60">{subtitle}</p>
        </div>
        {body}
      </div>
    </div>
  );

  if (mode === 'restore') {
    return shell(
      <Upload className="h-6 w-6 text-purple-400" />,
      'Restore your device',
      'Upload your recovery file and enter its passphrase to restore this account on this device.',
      <form onSubmit={(e) => void submitRestore(e)} className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-white/10 bg-[#1a1a26] px-4 py-3 text-sm text-white/60 transition-colors hover:border-purple-500/40">
          <Upload aria-hidden="true" className="h-4 w-4 shrink-0 text-white/60" />
          <span className="truncate">{file ? file.name : 'Choose your recovery file…'}</span>
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <input
          type="password"
          autoComplete="off"
          aria-label="Recovery passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Recovery passphrase"
          disabled={busy}
          className={INPUT}
        />
        {error && <p className="text-xs text-red-400/80">{error}</p>}
        <button
          type="submit"
          disabled={busy || !file || passphrase.length < MIN_PASSPHRASE}
          className={PRIMARY}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? 'Restoring…' : 'Restore this device'}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('default');
            setFile(null);
          }}
          className={LINK}
        >
          Back
        </button>
      </form>,
    );
  }

  if (status === 'needs-switch') {
    return shell(
      <UserCog className="h-6 w-6 text-purple-400" />,
      'Different account on this device',
      'This browser is set up for another Argus account. Set up your account here — this replaces the other account’s device, and you’ll need its recovery file to use it on this browser again.',
      <div className="space-y-3">
        {error && <p className="text-xs text-red-400/80">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void resetForNewAccount()}
          className={PRIMARY}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Set up my account here
        </button>
        <button type="button" onClick={() => setMode('restore')} className={LINK}>
          Restore my account from a recovery file instead
        </button>
      </div>,
    );
  }

  return shell(
    <Lock className="h-6 w-6 text-purple-400" />,
    creating ? 'Secure your device' : 'Unlock your device',
    creating
      ? 'Set a passphrase to encrypt your keys on this device. It never leaves your device and cannot be recovered if lost.'
      : 'Enter your passphrase to decrypt your keys on this device.',
    <form onSubmit={submitDefault} className="space-y-3">
      <input
        type="password"
        autoComplete={creating ? 'new-password' : 'current-password'}
        autoFocus
        aria-label="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Passphrase"
        disabled={busy}
        className={INPUT}
      />
      {creating && (
        <input
          type="password"
          autoComplete="new-password"
          aria-label="Confirm passphrase"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm passphrase"
          disabled={busy}
          className={INPUT}
        />
      )}
      {tooShort && (
        <p className="text-xs text-amber-400/80">Use at least {MIN_PASSPHRASE} characters.</p>
      )}
      {mismatch && <p className="text-xs text-amber-400/80">Passphrases don’t match.</p>}
      {error && <p className="text-xs text-red-400/80">{error}</p>}
      <button
        type="submit"
        disabled={
          busy || passphrase.length < MIN_PASSPHRASE || (creating && passphrase !== confirm)
        }
        className={PRIMARY}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? 'Working…' : creating ? 'Create & continue' : 'Unlock'}
      </button>
      <button
        type="button"
        onClick={() => {
          setMode('restore');
          setPassphrase('');
          setConfirm('');
        }}
        className={LINK}
      >
        Lost your device? Restore from a recovery file
      </button>
    </form>,
  );
}
