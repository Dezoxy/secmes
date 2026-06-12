import { useState, type ReactNode } from 'react';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { useAuth } from '../auth/AuthContext';
import { CreateWorkspace } from './CreateWorkspace';
import { JoinWorkspace, readPendingInviteToken } from './JoinWorkspace';

type Tab = 'create' | 'join';

function OnboardingScreen() {
  const { refreshProfile } = useAuth();
  const [tab, setTab] = useState<Tab>(() => (readPendingInviteToken() ? 'join' : 'create'));

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-3">
          <ArgusAppIcon className="h-10 w-10 rounded-2xl shadow-lg shadow-purple-500/25" />
          <span className="text-lg font-bold tracking-wider text-white/90">ARGUS</span>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-white">Get started</h2>
          <p className="mt-1 text-sm text-white/55">
            Create a new workspace or join one with an invite.
          </p>
        </div>

        <div
          className="flex rounded-xl border border-white/10 bg-white/[0.03] p-1"
          role="tablist"
          aria-label="Onboarding options"
        >
          <button
            role="tab"
            type="button"
            aria-selected={tab === 'create'}
            onClick={() => setTab('create')}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === 'create'
                ? 'bg-purple-500/20 text-purple-200'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            Create
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={tab === 'join'}
            onClick={() => setTab('join')}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === 'join'
                ? 'bg-purple-500/20 text-purple-200'
                : 'text-white/50 hover:text-white/80'
            }`}
          >
            Join
          </button>
        </div>

        {tab === 'create' && <CreateWorkspace onSuccess={refreshProfile} />}
        {tab === 'join' && <JoinWorkspace onSuccess={refreshProfile} />}
      </div>
    </div>
  );
}

/**
 * Gate for authenticated routes: shows the onboarding screen when the user is signed in but
 * not yet bound to a tenant. Demo mode (OIDC unconfigured) passes through without the gate.
 */
export function OnboardingGate({ children }: { children: ReactNode }): ReactNode {
  const { configured, ready, user, profile } = useAuth();

  if (configured && ready && user && !profile) {
    return <OnboardingScreen />;
  }

  return children;
}
