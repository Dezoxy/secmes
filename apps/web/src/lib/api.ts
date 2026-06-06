// Thin API client for the crypto-blind server. Attaches the OIDC access token as a Bearer header
// (the contract apps/api validates). In dev the SPA talks to `/api`, which the Vite dev server
// proxies to the API (http://localhost:3000) — same-origin from the browser, so no CORS. Override
// with VITE_API_URL for a non-proxied deployment.

import { accessToken } from './auth';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

async function authedHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** fetch() against the API with the Bearer token attached. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { ...init, headers: await authedHeaders(init.headers) });
}

/** The verified profile the API returns from the token claims (after JIT provisioning). */
export interface Me {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
}

/**
 * Record the login (POST /auth/session → JIT-provisions the user + audits `auth.login`), then fetch
 * the profile. Both run under the Bearer token, so the server derives identity + tenant from the
 * verified claims only. Returns the profile; throws on a non-OK response.
 */
export async function establishSession(): Promise<Me> {
  const session = await apiFetch('/auth/session', { method: 'POST' });
  if (!session.ok && session.status !== 204)
    throw new Error(`POST /auth/session → ${session.status}`);
  const me = await apiFetch('/me');
  if (!me.ok) throw new Error(`GET /me → ${me.status}`);
  return (await me.json()) as Me;
}

/** Result of publishing one-time KeyPackages to the directory. */
export interface PublishResult {
  deviceId: string;
  published: number;
}

/**
 * Publish this device's PUBLIC key material to the key directory (#19): the signature public key
 * (registers/upserts the device) + a batch of one-time-use KeyPackages a peer can claim to add this
 * device to a group. PUBLIC base64 only — no private keys leave the device. Idempotent: the server
 * dedups already-published packages, so re-publishing the pool each login is safe. Throws on non-OK.
 */
export async function publishKeyPackages(
  signaturePublicKey: string,
  keyPackages: string[],
): Promise<PublishResult> {
  const res = await apiFetch('/devices/me/key-packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signaturePublicKey, keyPackages }),
  });
  if (!res.ok) throw new Error(`POST /devices/me/key-packages → ${res.status}`);
  return (await res.json()) as PublishResult;
}
