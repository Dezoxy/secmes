import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { redeemCode, getRegisterOptions, verifyRegistration, fetchMe } from '../../lib/api';
import { useAuth, type MeBound } from './AuthContext';

interface RegisterScreenProps {
  onRegistered: (profile: MeBound) => void;
  onBack: () => void;
}

type Step = 'code' | 'ceremony' | 'done';

export function RegisterScreen({ onRegistered, onBack }: RegisterScreenProps) {
  const { notifyAuth } = useAuth();
  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setError(null);
    setBusy(true);
    try {
      setStep('ceremony');
      const { ceremonyId } = await redeemCode(code.trim());
      const { options } = await getRegisterOptions(ceremonyId);
      const regResponse = await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      const { accessToken: token } = await verifyRegistration(ceremonyId, regResponse);
      const me = await fetchMe();
      if (!me.bound) throw new Error('Registration succeeded but account is not yet bound.');
      notifyAuth(token, me);
      setStep('done');
      onRegistered(me);
    } catch (err) {
      setStep('code');
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Passkey creation was cancelled. Try again.'
          : 'Registration failed. Check your invite code and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to sign in
      </button>

      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-purple-400" />
        <h2 className="text-base font-semibold text-white">Create your account</h2>
      </div>

      {step === 'ceremony' ? (
        <p className="text-sm text-white/60">Follow your device prompt to register your passkey…</p>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <div>
            <label htmlFor="invite-code" className="mb-1.5 block text-xs text-white/50">
              Invite code
            </label>
            <input
              id="invite-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste your invite code…"
              autoFocus
              disabled={busy}
              className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="w-full rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
          >
            {busy ? 'Setting up…' : 'Create account with passkey'}
          </button>
        </form>
      )}
    </div>
  );
}
