import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { completeLogin } from '../lib/auth';

/**
 * OIDC redirect target. Completes the Authorization-Code + PKCE exchange (oidc-client-ts verifies
 * `state` and swaps the code for tokens against Zitadel), then routes into the app. No password or
 * code is logged. On failure the user sees a message and can retry from the login screen.
 */
export default function Callback() {
  const [status, setStatus] = useState('Completing sign-in…');
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    // signinCallback() is single-use (it consumes the code + PKCE state); guard the StrictMode
    // double-invoke so the second run doesn't error on an already-spent code.
    if (ran.current) return;
    ran.current = true;
    completeLogin()
      .then(() => navigate('/chat', { replace: true }))
      .catch((e: unknown) =>
        setStatus(`Sign-in failed: ${e instanceof Error ? e.message : 'unknown error'}`),
      );
  }, [navigate]);

  return (
    <div className="min-h-screen bg-[#1a1a24] flex items-center justify-center p-4 text-white/80">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold mb-2">argus</h1>
        <p className="text-white/50 text-sm">{status}</p>
      </div>
    </div>
  );
}
