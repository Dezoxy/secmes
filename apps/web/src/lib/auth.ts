// SPA OIDC login via oidc-client-ts — Authorization Code + PKCE, public client (no secret).
//
// Token handling per docs/threat-models/auth-tenant-context.md §8: the access token is a JWT held
// in MEMORY ONLY. The user/token store is an in-memory Storage shim (never localStorage/
// sessionStorage), so an XSS can't lift the token from persistent storage. While the tab is open,
// `automaticSilentRenew` refreshes it via the offline_access refresh token (no iframe). A full page
// reload intentionally drops the session (memory-only) — the user logs in again. The transient PKCE
// verifier + state DO use sessionStorage, but only for the redirect round-trip (oidc-client-ts clears
// them on callback). No password ever reaches our server; the server stays crypto-blind.

import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

const ISSUER = import.meta.env.VITE_OIDC_ISSUER as string | undefined;
const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;

/** True when the SPA has OIDC configured (VITE_OIDC_* present). Without it the app runs in demo mode. */
export const oidcConfigured = Boolean(ISSUER && CLIENT_ID);

/** Redirect URI — computed lazily (uses `window`), so importing this module is safe outside a browser. */
function redirectUri(): string {
  return (
    (import.meta.env.VITE_OIDC_REDIRECT_URI as string | undefined) ??
    `${window.location.origin}/auth/callback`
  );
}

/** A Storage-compatible in-memory store so oidc-client-ts keeps the user/token in memory only. */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

let manager: UserManager | null = null;
export function userManager(): UserManager {
  if (!oidcConfigured)
    throw new Error('OIDC is not configured (set VITE_OIDC_ISSUER + VITE_OIDC_CLIENT_ID)');
  manager ??= new UserManager({
    authority: ISSUER as string,
    client_id: CLIENT_ID as string,
    redirect_uri: redirectUri(),
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code', // PKCE is automatic for the code flow
    scope: 'openid profile email offline_access',
    automaticSilentRenew: true,
    // Token in memory only (§8). PKCE verifier/state are transient and may live in sessionStorage.
    userStore: new WebStorageStateStore({ store: createMemoryStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    monitorSession: false,
  });
  return manager;
}

/** Begin the OIDC redirect to Zitadel. */
export async function login(): Promise<void> {
  await userManager().signinRedirect();
}

/** Complete the redirect on the callback route: exchange the code for tokens (PKCE). */
export async function completeLogin(): Promise<User | undefined> {
  return userManager().signinCallback();
}

/** Clear the local session and hit Zitadel's end-session endpoint. */
export async function logout(): Promise<void> {
  await userManager().signoutRedirect();
}

/** The current in-memory user (null if not signed in or OIDC unconfigured). */
export async function getUser(): Promise<User | null> {
  if (!oidcConfigured) return null;
  return userManager().getUser();
}

/** The current access token for attaching to API calls, or null. */
export async function accessToken(): Promise<string | null> {
  return (await getUser())?.access_token ?? null;
}
