// OIDC Authorization Code + PKCE *initiation* for Zitadel.
// This only starts the front-channel redirect. The back-channel token exchange happens
// server-side in apps/api (Phase 1) — the SPA never holds a client secret, and no password
// ever reaches our server. Gated on VITE_OIDC_* env (see .env.example); a no-op until set.

const ISSUER = import.meta.env.VITE_OIDC_ISSUER as string | undefined;
const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined;
const REDIRECT_URI =
  (import.meta.env.VITE_OIDC_REDIRECT_URI as string | undefined) ??
  `${window.location.origin}/auth/callback`;

function base64UrlEncode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(random.buffer);
  // PKCE S256 challenge: OIDC auth plumbing (a standard WebCrypto SHA-256), NOT message E2EE.
  // Message/E2EE crypto must go through packages/crypto (the MLS wrapper); this is OAuth only.
  const subtle = crypto.subtle; // nosemgrep: secmes-crypto-only-in-crypto-package
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(digest) };
}

/** Begin the Zitadel OIDC login. No-op (with a warning) until VITE_OIDC_* are configured. */
export async function startLogin(): Promise<void> {
  if (!ISSUER || !CLIENT_ID) {
    // eslint-disable-next-line no-console
    console.warn('[auth] OIDC not configured — set VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID.');
    return;
  }
  const { verifier, challenge } = await createPkcePair();
  const state = crypto.randomUUID();
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('oidc_state', state);

  // TODO(Phase 1): resolve the authorize endpoint from `${ISSUER}/.well-known/openid-configuration`.
  const url = new URL(`${ISSUER.replace(/\/$/, '')}/oauth/v2/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email offline_access');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  window.location.assign(url.toString());
}
