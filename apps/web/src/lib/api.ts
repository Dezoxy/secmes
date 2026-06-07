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
  /** Net-new KeyPackages inserted by this call (already-published dups are skipped). */
  published: number;
  /** Total UNCLAIMED KeyPackages for this device after the call — drives replenishment. */
  available: number;
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

/** A tenant member as the directory exposes it — metadata only (no keys, no content). */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
}

/** List active members of the caller's tenant (RLS-scoped, metadata only) — the contact picker source. */
export async function listUsers(limit = 50): Promise<UserSummary[]> {
  const res = await apiFetch(`/users?limit=${encodeURIComponent(limit)}`);
  if (!res.ok) throw new Error(`GET /users → ${res.status}`);
  return (await res.json()) as UserSummary[];
}

/** One of a peer's one-time KeyPackages, claimed from the directory to add them to a group. */
export interface ClaimedKeyPackage {
  /** The peer device the package belongs to — pins where the Welcome must be delivered. */
  deviceId: string;
  /** The peer device's stable signature key — the safety-number input (#20). */
  signaturePublicKey: string;
  /** The opaque base64 KeyPackage to deserialize + `addMember`. */
  keyPackage: string;
}

/**
 * Claim ONE unclaimed one-time KeyPackage for `userId` (a peer in this tenant). One-time-use: the server
 * marks it claimed so no two conversations seal to the same package. The returned package is UNTRUSTED
 * until its safety number (#20) is verified out-of-band — a malicious server could substitute keys.
 * Throws a distinct error when the peer has no packages (404) so the UI can prompt to retry later.
 */
export async function claimKeyPackage(userId: string): Promise<ClaimedKeyPackage> {
  const res = await apiFetch(`/users/${encodeURIComponent(userId)}/key-package/claim`, {
    method: 'POST',
  });
  if (res.status === 404) throw new Error('this contact has no key packages available yet');
  if (!res.ok) throw new Error(`POST /users/${userId}/key-package/claim → ${res.status}`);
  return (await res.json()) as ClaimedKeyPackage;
}

/** Create a conversation with the given other members (the caller is added server-side). */
export async function createConversation(
  memberUserIds: string[],
): Promise<{ conversationId: string }> {
  const res = await apiFetch('/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberUserIds }),
  });
  if (!res.ok) throw new Error(`POST /conversations → ${res.status}`);
  return (await res.json()) as { conversationId: string };
}

/** The Welcome (+ ratchet tree) to deliver — opaque base64; the server stores and forwards it blind. */
export interface DeliverWelcomeBody {
  recipientUserId: string;
  recipientDeviceId: string;
  welcome: string;
  ratchetTree: string;
}

/** Deliver an MLS Welcome sealing `conversationId` to the recipient's claimed device. Opaque to the server. */
export async function deliverWelcome(
  conversationId: string,
  body: DeliverWelcomeBody,
): Promise<{ welcomeId: string }> {
  const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/welcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /conversations/${conversationId}/welcomes → ${res.status}`);
  return (await res.json()) as { welcomeId: string };
}

/** A pending Welcome addressed to this device — metadata only (the sealed blobs are fetched separately). */
export interface PendingWelcome {
  id: string;
  conversationId: string;
  createdAt: string;
}

/** List this device's pending Welcomes (metadata only; RLS- + device-scoped on the server). */
export async function listWelcomes(deviceId: string, limit = 50): Promise<PendingWelcome[]> {
  const res = await apiFetch(
    `/welcomes?deviceId=${encodeURIComponent(deviceId)}&limit=${encodeURIComponent(limit)}`,
  );
  if (!res.ok) throw new Error(`GET /welcomes → ${res.status}`);
  return (await res.json()) as PendingWelcome[];
}

/** The opaque sealed join material for a Welcome (base64; the client deserializes + joins it). */
export interface WelcomeMaterial {
  welcome: string;
  ratchetTree: string;
}

/**
 * Fetch a Welcome's sealed material. `proof` is the base64url Ed25519 FETCH proof-of-possession for this
 * device over (deviceId, welcomeId), so only the owning device can retrieve its join material. Opaque base64.
 */
export async function fetchWelcomeMaterial(
  welcomeId: string,
  deviceId: string,
  proof: string,
): Promise<WelcomeMaterial> {
  const res = await apiFetch(
    `/welcomes/${encodeURIComponent(welcomeId)}/material?deviceId=${encodeURIComponent(deviceId)}&proof=${encodeURIComponent(proof)}`,
  );
  if (!res.ok) throw new Error(`GET /welcomes/${welcomeId}/material → ${res.status}`);
  return (await res.json()) as WelcomeMaterial;
}

/**
 * Consume (delete) a Welcome after joining. `proof` is the base64url Ed25519 CONSUME proof (a distinct
 * domain from fetch), so only the owning device can destroy its join material. Expects 204.
 */
export async function consumeWelcome(
  welcomeId: string,
  deviceId: string,
  proof: string,
): Promise<void> {
  const res = await apiFetch(
    `/welcomes/${encodeURIComponent(welcomeId)}?deviceId=${encodeURIComponent(deviceId)}&proof=${encodeURIComponent(proof)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`DELETE /welcomes/${welcomeId} → ${res.status}`);
}
