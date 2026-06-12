import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { createTenant } from '../../lib/api';
import { Button } from '../ui';

interface CreateWorkspaceProps {
  onSuccess: () => Promise<void>;
}

export function CreateWorkspace({ onSuccess }: CreateWorkspaceProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await createTenant(trimmed);
    } catch {
      setError('Could not create workspace. Please try again.');
      setLoading(false);
      return;
    }
    // Workspace created — reload profile. If this fails the workspace still exists;
    // a page refresh will complete the transition.
    try {
      await onSuccess();
    } catch {
      setError('Workspace created — please refresh the page to continue.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15">
          <Building2 className="h-5 w-5 text-purple-300" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Create a workspace</h3>
          <p className="text-sm text-white/55">You'll be the admin and can invite others.</p>
        </div>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workspace-name" className="text-sm font-medium text-white/70">
            Workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
            maxLength={100}
            autoFocus
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30"
          />
        </div>

        {error && <p className="text-sm text-rose-300">{error}</p>}

        <Button
          type="submit"
          disabled={!name.trim()}
          loading={loading}
          loadingLabel="Creating…"
          className="w-full"
        >
          Create workspace
        </Button>
      </form>
    </div>
  );
}
