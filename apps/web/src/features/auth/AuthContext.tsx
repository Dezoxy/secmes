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
import type { User } from 'oidc-client-ts';
import {
  oidcConfigured,
  userManager,
  login as oidcLogin,
  logout as oidcLogout,
  profileScopeFromAuth,
} from '../../lib/auth';
import { establishSession, fetchMe, type MeBound } from '../../lib/api';

interface AuthState {
  /** Whether OIDC is configured (VITE_OIDC_*). When false the app runs in demo mode (no real auth). */
  configured: boolean;
  /** Initial session restore finished — render gated routes only after this. */
  ready: boolean;
  user: User | null;
  /** Stable authenticated subject, used only for storage scoping and auth boundaries. */
  subjectId: string | null;
  /** Bound server profile from /me (null when unbound, loading, or API unreachable). */
  profile: MeBound | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  /** Re-fetch /me and update profile state — call after createTenant or acceptInvite. */
  refreshProfile: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<MeBound | null>(null);
  const [ready, setReady] = useState(!oidcConfigured);
  const sessionEstablished = useRef(false);

  useEffect(() => {
    if (!oidcConfigured) return;
    const um = userManager();
    let active = true;
    void um
      .getUser()
      .then((u) => active && setUser(u))
      .finally(() => active && setReady(true));

    const onLoaded = (u: User) => setUser(u);
    const onGone = () => {
      setUser(null);
      setProfile(null);
      sessionEstablished.current = false;
    };
    um.events.addUserLoaded(onLoaded);
    um.events.addUserUnloaded(onGone);
    um.events.addAccessTokenExpired(onGone);
    return () => {
      active = false;
      um.events.removeUserLoaded(onLoaded);
      um.events.removeUserUnloaded(onGone);
      um.events.removeAccessTokenExpired(onGone);
    };
  }, []);

  // On the first authenticated user (not on silent renews), record the login + fetch the profile.
  // Best-effort: if the API is down, auth still succeeds and the app runs without a server profile.
  useEffect(() => {
    if (!user || sessionEstablished.current) return;
    sessionEstablished.current = true;
    void establishSession()
      .then((me) => setProfile(me.bound ? me : null))
      .catch(() => {
        /* API unreachable — keep the OIDC session, no server profile yet */
      });
  }, [user]);

  const refreshProfile = useCallback(async (): Promise<void> => {
    const me = await fetchMe();
    setProfile(me.bound ? me : null);
  }, []);

  const value: AuthState = {
    configured: oidcConfigured,
    ready,
    user,
    subjectId: profileScopeFromAuth(user, profile?.userId),
    profile,
    login: oidcLogin,
    logout: oidcLogout,
    refreshProfile,
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** Gate a route: demo mode (OIDC unconfigured) passes through; otherwise require a signed-in user. */
export function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { configured, ready, user } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#1a1a24] text-white/50">
        Restoring session…
      </div>
    );
  }
  if (configured && !user) return <Navigate to="/" replace />;
  return children;
}
