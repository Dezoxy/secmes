import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { completeLogin } from '../lib/auth';

/**
 * OIDC redirect target. Completes Authorization Code + PKCE, then routes into the
 * app. The callback is intentionally separate from chat so failed sign-in never
 * renders the product surface.
 */
export default function AuthCallbackRoute() {
  const [status, setStatus] = useState('Completing sign-in...');
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    completeLogin()
      .then(() => navigate('/chat', { replace: true }))
      .catch(() => setStatus('Sign-in failed. Return to the login screen and retry.'));
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4 text-white/80">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-xl font-semibold">argus</h1>
        <p className="text-sm text-white/50">{status}</p>
      </div>
    </div>
  );
}
