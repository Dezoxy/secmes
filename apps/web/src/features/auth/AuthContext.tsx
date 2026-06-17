import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Navigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { demoMode, setToken } from '../../lib/auth';
import {
  fetchMe,
  getAuthenticateOptions,
  verifyAuthentication,
  refreshSession,
  logoutSession,
  type MeBound,
} from '../../lib/api';

export type { MeBound };

interface AuthState {
  /** Initial session restore finished — render gated routes only after this. */
  ready: boolean;
  /** True when a valid session exists (token obtained), even if not yet bound to a tenant. */
  authenticated: boolean;
  /** Bound server profile from /me (null when unauthenticated, unbound, or loading). */
  profile: MeBound | null;
  /** Stable user id for storage scoping (= profile.userId when authenticated). */
  subjectId: string | null;
  /** True when app runs without real auth (seed-driven demo). */
  demoMode: boolean;
  /** Run the discoverable-passkey authentication ceremony. Throws on failure. */
  login: () => Promise<void>;
  /** Revoke the current session. */
  logout: () => Promise<void>;
  /** Re-fetch /me — call after createTenant or acceptInvite. */
  refreshProfile: () => Promise<void>;
  /**
   * Apply a token+profile obtained outside the normal login flow (registration, breakglass).
   * Sets authenticated=true and calls navigator.storage.persist().
   */
  notifyAuth: (token: string, profile: MeBound | null) => void;
}

const AuthCtx = createContext<AuthState | null>(null);

// Nine-minute interval: renew before the 10-minute JWT window closes.
const REFRESH_INTERVAL_MS = 9 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [profile, setProfile] = useState<MeBound | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(demoMode);
  const storagePersisted = useRef(false);

  const applySession = useCallback((token: string, me: MeBound | null) => {
    setToken(token);
    setAuthenticated(true);
    setProfile(me);
    if (me && !storagePersisted.current) {
      storagePersisted.current = true;
      void navigator.storage?.persist();
    }
  }, []);

  const clearSession = useCallback(() => {
    setToken(null);
    setAuthenticated(false);
    setProfile(null);
  }, []);

  // Boot: try to restore session from the argus_refresh cookie.
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    refreshSession()
      .then(async ({ accessToken: token }) => {
        if (!active) return;
        setToken(token);
        const me = await fetchMe();
        if (!active) return;
        applySession(token, me.bound ? me : null);
      })
      .catch(() => {
        // No valid cookie — start unauthenticated.
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []); // boot effect: runs once on mount

  // Refresh timer: keep access token alive while the tab is open.
  useEffect(() => {
    if (demoMode) return;
    const timer = setInterval(() => {
      if (!profile) return;
      refreshSession()
        .then(async ({ accessToken: token }) => {
          setToken(token);
          const me = await fetchMe();
          setProfile(me.bound ? me : null);
        })
        .catch(() => clearSession());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [profile, clearSession]);

  const login = useCallback(async (): Promise<void> => {
    const opts = await getAuthenticateOptions();
    const response = await startAuthentication({
      optionsJSON: opts.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    const { accessToken: token } = await verifyAuthentication(opts.ceremonyId, response);
    setToken(token); // must be set before fetchMe so the bearer header is present
    const me = await fetchMe();
    applySession(token, me.bound ? me : null);
  }, [applySession]);

  const logout = useCallback(async (): Promise<void> => {
    await logoutSession().catch(() => {});
    clearSession();
  }, [clearSession]);

  const refreshProfile = useCallback(async (): Promise<void> => {
    const me = await fetchMe();
    setProfile(me.bound ? me : null);
  }, []);

  const value: AuthState = {
    ready,
    authenticated,
    profile,
    subjectId: profile?.userId ?? null,
    demoMode,
    login,
    logout,
    refreshProfile,
    notifyAuth: applySession,
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** Gate a route: demo mode passes through; otherwise require an authenticated session.
 * OnboardingGate (inside the chat route) handles the authenticated-but-unbound case. */
export function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { ready, demoMode: demo, authenticated } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] text-white/50">
        Restoring session…
      </div>
    );
  }
  if (!demo && !authenticated) return <Navigate to="/" replace />;
  return children;
}
