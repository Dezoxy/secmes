import { Navigate, useNavigate } from 'react-router-dom';

import { BreakglassLogin } from '../features/auth/BreakglassLogin';
import { useAuth } from '../features/auth/AuthContext';
import { surfaceEnterMotion } from '../features/ui';

// Standalone admin (breakglass) login page on its own path (/admin) — off the public landing. In production
// this path, and the breakglass/admin API, are reachable ONLY through Cloudflare Access: Caddy returns 404
// unless the request carries the Access-injected header (see infra/stack/caddy/Caddyfile +
// docs/threat-models/admin-access-gating.md). NOT wrapped in RequireAuth — it's the unauthenticated door used
// to obtain an admin session. In dev (no Caddy/Access) it renders directly, exactly like before.
export default function AdminLoginRoute() {
  const { ready, profile } = useAuth();
  const navigate = useNavigate();

  // Already signed in → skip the login form.
  if (ready && profile) return <Navigate to="/chat" replace />;

  return (
    <main
      aria-label="Admin access"
      className="flex min-h-screen items-center justify-center bg-[#1a1a24] p-4"
    >
      <section
        className={`w-full max-w-[430px] rounded-3xl bg-[#12121a] p-6 shadow-2xl shadow-black/50 ${surfaceEnterMotion}`}
      >
        <BreakglassLogin onLoggedIn={() => navigate('/chat')} onBack={() => navigate('/')} />
      </section>
    </main>
  );
}
