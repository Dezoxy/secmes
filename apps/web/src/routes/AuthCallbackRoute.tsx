import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { completeLogin } from '../lib/auth';
import { createSafeUiError, type SafeUiError } from '../lib/safe-ui-error';
import { ErrorState, LoadingState } from '../features/ui';

/**
 * OIDC redirect target. Completes Authorization Code + PKCE, then routes into the
 * app. The callback is intentionally separate from chat so failed sign-in never
 * renders the product surface.
 */
export default function AuthCallbackRoute() {
  const [error, setError] = useState<SafeUiError | null>(null);
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    completeLogin()
      .then(() => navigate('/chat', { replace: true }))
      .catch(() =>
        setError(
          createSafeUiError({
            title: 'Sign-in failed',
            message: 'Return to the login screen and retry.',
            kind: 'auth-callback',
          }),
        ),
      );
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4 text-white/80">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-xl font-semibold">argus</h1>
        {error ? (
          <ErrorState error={error} />
        ) : (
          <LoadingState title="Completing sign-in">Finishing the secure redirect.</LoadingState>
        )}
      </div>
    </div>
  );
}
