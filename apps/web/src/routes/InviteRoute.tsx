import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';
import { storePendingInviteToken } from '../features/onboarding/JoinWorkspace';
import { Button, LoadingState } from '../features/ui';

/**
 * Landing page for invite links: `/invite#<token>`.
 *
 * The token is in the URL fragment so it is never sent to any server in an HTTP log.
 * Behaviour:
 *   - Demo mode              → skip to /chat
 *   - Not authenticated      → store token, call login()
 *   - Authenticated + unbound → store token, navigate to /chat (OnboardingGate shows JoinWorkspace)
 *   - Authenticated + bound  → show "already in a workspace"
 */
export default function InviteRoute() {
  const { demoMode, ready, authenticated, profile } = useAuth();
  const navigate = useNavigate();
  const handled = useRef(false);

  const token = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';

  useEffect(() => {
    if (!ready || handled.current) return;
    if (demoMode) {
      handled.current = true;
      void navigate('/chat', { replace: true });
      return;
    }

    if (!authenticated) {
      // Not authenticated: park the token and send to the landing page where the user can
      // sign in (existing passkey) or create a new account via RegisterScreen.
      // Calling login() directly breaks new users who don't have a passkey credential yet.
      handled.current = true;
      if (token) storePendingInviteToken(token);
      void navigate('/', { replace: true });
      return;
    }

    if (profile) {
      // Already bound — nothing to do; render the "already in workspace" UI below.
      return;
    }

    // Authenticated and unbound: store the token, let OnboardingGate handle it.
    handled.current = true;
    if (token) storePendingInviteToken(token);
    void navigate('/chat', { replace: true });
  }, [ready, demoMode, authenticated, profile, token, navigate]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4 text-white/80">
        <LoadingState title="Opening invite">Verifying your invite link…</LoadingState>
      </div>
    );
  }

  if (profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50 text-center">
          <ArgusAppIcon className="h-12 w-12 rounded-2xl shadow-lg shadow-purple-500/25" />
          <div>
            <h2 className="text-xl font-semibold text-white">Already in a workspace</h2>
            <p className="mt-2 text-sm text-white/55">
              You're already a member of a workspace. Only one workspace per account is supported.
            </p>
          </div>
          <Button onClick={() => void navigate('/chat', { replace: true })}>Go to chat</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4 text-white/80">
      <LoadingState title="Opening invite">Redirecting…</LoadingState>
    </div>
  );
}
