import { useEffect, useState } from 'react';
import { Link } from 'lucide-react';
import { acceptInvite } from '../../lib/api';
import { Button } from '../ui';

const PENDING_INVITE_KEY = 'pendingInviteToken';

export function storePendingInviteToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, token);
  } catch {
    /* sessionStorage unavailable */
  }
}

export function clearPendingInviteToken(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* noop */
  }
}

function readPendingInviteToken(): string {
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY) ?? '';
  } catch {
    return '';
  }
}

interface JoinWorkspaceProps {
  /** Pre-filled token (e.g. from URL fragment). Takes precedence over sessionStorage. */
  initialToken?: string;
  onSuccess: () => Promise<void>;
}

export function JoinWorkspace({ initialToken, onSuccess }: JoinWorkspaceProps) {
  const [token, setToken] = useState(() => initialToken ?? readPendingInviteToken());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialToken) {
      setToken(initialToken);
      storePendingInviteToken(initialToken);
    }
  }, [initialToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await acceptInvite(trimmed);
    } catch {
      setError('Invalid or expired invite. Please ask for a new link.');
      setLoading(false);
      return;
    }
    clearPendingInviteToken();
    // Invite accepted — reload profile. If this fails the binding still exists;
    // a page refresh will complete the transition.
    try {
      await onSuccess();
    } catch {
      setError('Joined — please refresh the page to continue.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15">
          <Link className="h-5 w-5 text-purple-300" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Join a workspace</h3>
          <p className="text-sm text-white/55">Paste the invite token from your invite link.</p>
        </div>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-token" className="text-sm font-medium text-white/70">
            Invite token
          </label>
          <input
            id="invite-token"
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your invite token here"
            autoFocus={!token}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30"
          />
        </div>

        {error && <p className="text-sm text-rose-300">{error}</p>}

        <Button
          type="submit"
          disabled={!token.trim()}
          loading={loading}
          loadingLabel="Joining…"
          className="w-full"
        >
          Join workspace
        </Button>
      </form>
    </div>
  );
}
