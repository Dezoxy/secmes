import { useEffect, useState } from 'react';

/** OIDC redirect target. Validates state; the back-channel token exchange lands in Phase 1 (apps/api). */
export default function Callback() {
  const [status, setStatus] = useState('Completing sign-in…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const code = params.get('code');
    const state = params.get('state');
    const expectedState = sessionStorage.getItem('oidc_state');

    if (error) {
      setStatus(`Sign-in failed: ${error}`);
      return;
    }
    if (!code || !state || state !== expectedState) {
      setStatus('Invalid callback (state mismatch).');
      return;
    }
    // TODO(Phase 1): POST { code, code_verifier } to apps/api for the back-channel token exchange.
    setStatus('Authorization code received — token exchange happens server-side in Phase 1.');
  }, []);

  return (
    <div className="min-h-screen bg-[#1a1a24] flex items-center justify-center p-4 text-white/80">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold mb-2">secmes</h1>
        <p className="text-white/50 text-sm">{status}</p>
      </div>
    </div>
  );
}
