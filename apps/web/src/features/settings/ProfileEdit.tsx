import { useState } from 'react';
import { User } from 'lucide-react';
import { updateProfile } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';

export function ProfileEdit() {
  const { profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!profile || profile.isBreakglass) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name || busy) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await updateProfile({ displayName: name });
      await refreshProfile();
      setSaved(true);
    } catch {
      setError('Save failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-white/5 bg-[#12121a] p-5">
      <div className="mb-4 flex items-center gap-2">
        <User className="h-4 w-4 text-purple-400" />
        <h2 className="text-sm font-semibold text-white">Profile</h2>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div>
          <label htmlFor="display-name" className="mb-1.5 block text-xs text-white/50">
            Display name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
            maxLength={64}
            placeholder="Your name…"
            disabled={busy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
          />
        </div>

        <div>
          <p className="mb-1.5 text-xs text-white/50">Argus ID</p>
          <p className="select-all rounded-xl border border-white/5 bg-[#0f0f16] px-4 py-2.5 font-mono text-xs text-white/60">
            {profile.argusId}
          </p>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {saved && <p className="text-xs text-green-400">Saved.</p>}

        <button
          type="submit"
          disabled={busy || !displayName.trim()}
          className="self-end rounded-xl bg-purple-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}
