import { User } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { DisplayNameEditor } from './DisplayNameEditor';

export function ProfileEdit() {
  const { profile } = useAuth();

  if (!profile || profile.isBreakglass) return null;

  return (
    <section className="rounded-2xl border border-white/5 bg-[#12121a] p-5">
      <div className="mb-4 flex items-center gap-2">
        <User className="h-4 w-4 text-purple-400" />
        <h2 className="text-sm font-semibold text-white">Profile</h2>
      </div>

      <DisplayNameEditor />

      <div className="mt-3">
        <p className="mb-1.5 text-xs text-white/50">Argus ID</p>
        <p className="select-all rounded-xl border border-white/5 bg-[#0f0f16] px-4 py-2.5 font-mono text-xs text-white/60">
          {profile.argusId}
        </p>
      </div>
    </section>
  );
}
