import { useState, type FormEvent, type ReactNode } from 'react';

import { Loader2, Lock } from 'lucide-react';

import { useDevice } from './DeviceContext';

// Gates the chat on an unlocked MLS device. The device keys are sealed at rest under a passphrase
// (Argon2id + AES-GCM) — this prompts to unlock an existing device or set a passphrase on first run,
// then DeviceProvider provisions + publishes the KeyPackage pool. Demo mode short-circuits ('ready').
// v1 UX: a local passcode gate (the sealed-keystore pattern); strength meter / timeout are follow-ups.
const MIN_PASSPHRASE = 8;

export function UnlockGate({ children }: { children: ReactNode }): ReactNode {
  const { status, error, unlock } = useDevice();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');

  if (status === 'ready') return <>{children}</>;

  const creating = status === 'needs-create';
  const busy = status === 'unlocking' || status === 'loading';
  const mismatch = creating && confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const canSubmit =
    !busy && passphrase.length >= MIN_PASSPHRASE && (!creating || passphrase === confirm);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (canSubmit) void unlock(passphrase);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4">
      <div className="w-full max-w-sm rounded-3xl bg-[#12121a] p-8 shadow-2xl shadow-black/50">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-purple-500/20">
            <Lock className="h-6 w-6 text-purple-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">
            {creating ? 'Secure your device' : 'Unlock your device'}
          </h1>
          <p className="mt-1 text-sm text-white/40">
            {creating
              ? 'Set a passphrase to encrypt your keys on this device. It never leaves your device and cannot be recovered if lost.'
              : 'Enter your passphrase to decrypt your keys on this device.'}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Passphrase"
            disabled={busy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-3 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
          />
          {creating && (
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm passphrase"
              disabled={busy}
              className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-3 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
            />
          )}

          {tooShort && (
            <p className="text-xs text-amber-400/80">Use at least {MIN_PASSPHRASE} characters.</p>
          )}
          {mismatch && <p className="text-xs text-amber-400/80">Passphrases don’t match.</p>}
          {error && <p className="text-xs text-red-400/80">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-3 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? 'Working…' : creating ? 'Create & continue' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}
