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
import { stashUnlockKey, unlockKeyFromResponse, withPrfSalt } from '../../lib/prf';
import { syncMuteStateToCache, unmuteAll } from '../settings/conversation-mute';

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
  /** Re-fetch /me — call after a profile change (e.g. display name / avatar update). */
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

// Serialise refresh-cookie rotation across tabs via the Web Locks API.
// The argus_refresh cookie is single-use; presenting the same cookie from two
// tabs simultaneously triggers reuse-detection and revokes the entire session.
// Blocking mode (both boot and timer) ensures rotations are sequential:
// Tab A presents C0→C1, then Tab B presents C1→C2. Each tab gets a fresh token.
const SESSION_REFRESH_LOCK = 'argus-session-refresh';

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return fn();
  return navigator.locks.request(SESSION_REFRESH_LOCK, fn);
}

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
    // Clear per-conversation mute state so a subsequent user on this device
    // doesn't inherit stale mute data via localStorage or the SW cache.
    unmuteAll();
    void syncMuteStateToCache(new Set());
  }, []);

  // Boot: try to restore session from the argus_refresh cookie.
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    withRefreshLock(async () => {
      const { accessToken: token } = await refreshSession();
      if (!active) return;
      setToken(token);
      const me = await fetchMe();
      if (!active) return;
      applySession(token, me.bound ? me : null);
    })
      .catch((err: unknown) => {
        // Distinguish a definitive "no session" (401) from transient failures
        // (network errors, 5xx). Only wipe per-user state when the refresh
        // cookie is genuinely gone — not when the server is briefly unavailable.
        const is401 = err instanceof Error && /status 401/.test(err.message);
        if (is401) {
          unmuteAll();
          void syncMuteStateToCache(new Set());
        }
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []); // boot effect: runs once on mount

  // Refresh timer: keep access token alive while the tab is open. Keyed on `authenticated`.
  useEffect(() => {
    if (demoMode) return;
    const timer = setInterval(() => {
      if (!authenticated) return;
      void withRefreshLock(async () => {
        const { accessToken: token } = await refreshSession();
        setToken(token);
        const me = await fetchMe();
        setProfile(me.bound ? me : null);
      }).catch(() => clearSession());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authenticated, clearSession]);

  const login = useCallback(async (): Promise<void> => {
    const opts = await getAuthenticateOptions();
    // Inject the PRF salt so this same assertion yields the keystore unlock secret (no second prompt). The
    // server's options already enable PRF; the client supplies eval.first as raw bytes (lib/prf.ts).
    const response = await startAuthentication({
      optionsJSON: withPrfSalt(opts.options as unknown as PublicKeyCredentialRequestOptionsJSON),
    });
    // Derive the keystore unlock key from PRF AND strip the secret from `response` BEFORE the verify POST —
    // the server is crypto-blind and must never receive it. null when the authenticator has no PRF (the
    // device gate then surfaces the fresh-start message).
    const unlockKey = await unlockKeyFromResponse(response);
    const { accessToken: token } = await verifyAuthentication(opts.ceremonyId, response);
    setToken(token); // must be set before fetchMe so the bearer header is present
    const me = await fetchMe();
    if (unlockKey) stashUnlockKey(unlockKey);
    applySession(token, me.bound ? me : null);
  }, [applySession]);

  const logout = useCallback(async (): Promise<void> => {
    // Pre-refresh so the logout bearer is valid even after sleep/throttle.
    // If the refresh cookie is already dead the catch is a no-op — the session
    // is already gone server-side, so clearing local state is still correct.
    await refreshSession()
      .then(({ accessToken: t }) => setToken(t))
      .catch(() => {});
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

/** Gate a route: demo mode passes through; otherwise require an authenticated session. */
export function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { ready, demoMode: demo, authenticated } = useAuth();
  if (!ready) {
    return (
      <div className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-[#1a1a24] text-white/50">
        Restoring session…
      </div>
    );
  }
  if (!demo && !authenticated) return <Navigate to="/" replace />;
  return children;
}
