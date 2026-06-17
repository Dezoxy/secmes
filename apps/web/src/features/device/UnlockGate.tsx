import { useEffect, useRef, type ReactNode } from 'react';

import { KeyRound, Loader2, Lock, UserCog } from 'lucide-react';

import { hasPendingUnlockKey } from '../../lib/prf';
import { useDevice } from './DeviceContext';

// Gates the chat on an unlocked MLS device. The device keys are sealed at rest under the passkey-PRF unlock
// key (no passphrase) — unlock is automatic when the login/registration ceremony already produced the key,
// and one tap (a fresh passkey assertion) on reload. There is NO recovery: a lost passkey / wiped browser is
// a fresh start (ask your admin for a new registration code). A SWITCH path handles a browser already holding
// a different account's device (single slot, v1). The breakglass admin and demo mode short-circuit ('ready').

const CARD = 'w-full max-w-sm rounded-3xl bg-[#12121a] p-8 shadow-2xl shadow-black/50';
const PRIMARY =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-3 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-40';

export function UnlockGate({ children }: { children: ReactNode }): ReactNode {
  const { status, error, unlock, resetForNewAccount } = useDevice();
  const autoTried = useRef(false);

  const creating = status === 'needs-create';
  const busy = status === 'unlocking' || status === 'loading';

  // Auto-unlock with no prompt ONLY when the login/registration ceremony already stashed the unlock key — a
  // fresh assertion needs a user gesture, so on reload (no stashed key) we wait for the button click below.
  useEffect(() => {
    if (autoTried.current || error) return;
    if (status !== 'needs-unlock' && status !== 'needs-create') return;
    if (!hasPendingUnlockKey()) return;
    autoTried.current = true;
    void unlock();
  }, [status, error, unlock]);

  if (status === 'ready') return <>{children}</>;

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

  // No PRF on this authenticator (or the keystore can't be opened) — there is no recovery path.
  if (status === 'error') {
    return shell(
      <Lock className="h-6 w-6 text-purple-400" />,
      'This device can’t be used',
      'Your passkey can’t unlock secure messaging on this device. Ask your admin for a new registration code to start fresh.',
      <>{error && <p className="text-center text-xs text-red-400/80">{error}</p>}</>,
    );
  }

  if (status === 'needs-switch') {
    return shell(
      <UserCog className="h-6 w-6 text-purple-400" />,
      'Different account on this device',
      'This browser is set up for another Argus account. Set up your account here — this replaces the other account’s device, and there is no way to restore it (lost access means a new registration code from your admin).',
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
      </div>,
    );
  }

  // needs-unlock / needs-create — automatic when a key was stashed (spinner), otherwise a passkey click.
  return shell(
    <KeyRound className="h-6 w-6 text-purple-400" />,
    busy ? 'Unlocking…' : creating ? 'Set up this device' : 'Unlock with your passkey',
    creating
      ? 'Create your encrypted message store on this device. It’s protected by your passkey — no password to remember, and nothing to recover if your passkey is lost.'
      : 'Use your passkey to unlock your encrypted messages on this device.',
    <div className="space-y-3">
      {error && <p className="text-xs text-red-400/80">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void unlock()} className={PRIMARY}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? 'Working…' : creating ? 'Set up this device' : 'Unlock'}
      </button>
    </div>,
  );
}
