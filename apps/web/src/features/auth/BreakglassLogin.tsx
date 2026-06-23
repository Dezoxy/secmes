import { useState } from 'react';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { breakglassLogin, fetchMe } from '../../lib/api';
import { setToken } from '../../lib/auth';
import { useAuth, type MeBound } from './AuthContext';

interface BreakglassLoginProps {
  onLoggedIn: (profile: MeBound) => void;
  onBack: () => void;
}

export function BreakglassLogin({ onLoggedIn, onBack }: BreakglassLoginProps) {
  const { notifyAuth } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setError(null);
    setBusy(true);
    try {
      const result = await breakglassLogin(username.trim(), password);
      if (!result.ok) {
        if (result.status === 429) {
          setError('Account locked. Try again in 15 minutes.');
        } else if (result.status === 503) {
          setError('Admin login is not configured on this server.');
        } else if (result.error.kind === 'invalid-json' || result.error.kind === 'network') {
          setError(
            'Cannot reach the server. Your Cloudflare Access session may have expired — re-authenticate and try again.',
          );
        } else {
          setError('Invalid credentials.');
        }
        return;
      }
      const { accessToken: token } = result.data;
      setToken(token); // must be set before fetchMe so the bearer header is present
      const me = await fetchMe();
      if (!me.bound) throw new Error('Login succeeded but profile is not bound.');
      notifyAuth(token, me);
      onLoggedIn(me);
    } catch {
      setError('Invalid credentials.');
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
        <ShieldAlert className="h-5 w-5 text-amber-400" />
        <h2 className="text-base font-semibold text-white">Admin access</h2>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div>
          <label htmlFor="bg-username" className="mb-1.5 block text-xs text-white/50">
            Username
          </label>
          <input
            id="bg-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            disabled={busy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-amber-500/50 disabled:opacity-50"
          />
        </div>

        <div>
          <label htmlFor="bg-password" className="mb-1.5 block text-xs text-white/50">
            Password
          </label>
          <input
            id="bg-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-amber-500/50 disabled:opacity-50"
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full rounded-xl bg-amber-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-amber-400 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
