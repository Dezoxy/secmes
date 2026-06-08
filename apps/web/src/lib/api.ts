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

/** The directory's response to a revoke. */
export interface RevokeResult {
  /** How many UNCLAIMED KeyPackages were deleted for this device. */
  revoked: number;
}

/**
 * Revoke (delete) this device's UNCLAIMED KeyPackages from the directory — called before re-provisioning a
 * cleared/restored device, so its now-unopenable old packages (whose one-time privates were discarded) can't
 * be claimed by a peer who'd then seal a Welcome this device can never open (device-provisioning §6, #20).
 * Server-side, this only affects the caller's OWN device (resolved from the verified user + this signature
 * key). Throws on non-OK — callers treat it as best-effort (the stale packages are an availability residual).
 */
export async function revokeKeyPackages(signaturePublicKey: string): Promise<RevokeResult> {
  const res = await apiFetch('/devices/me/key-packages/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signaturePublicKey }),
  });
  if (!res.ok) throw new Error(`POST /devices/me/key-packages/revoke → ${res.status}`);
  return (await res.json()) as RevokeResult;
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

/**
 * The send payload — opaque base64 `ciphertext` plus non-secret routing metadata. `clientMessageId` is the
 * per-(sender, conversation) idempotency key (a retry returns the same row, no double fan-out). The server
 * stores and forwards this blind; it never sees plaintext or keys.
 */
export interface SendMessageBody {
  clientMessageId: string;
  ciphertext: string;
  alg: string;
  epoch: number;
  attachmentObjectKey?: string;
}

/** The server's ack for a sent message. `deduplicated` = an idempotent retry matched an existing row. */
export interface SentMessage {
  messageId: string;
  createdAt: string;
  deduplicated: boolean;
}

/** Send one MLS-encrypted message to a conversation. Idempotent on `clientMessageId`. Throws on non-OK. */
export async function sendMessage(
  conversationId: string,
  body: SendMessageBody,
): Promise<SentMessage> {
  const res = await apiFetch(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /conversations/${conversationId}/messages → ${res.status}`);
  return (await res.json()) as SentMessage;
}

/**
 * A message as the server returns it — opaque base64 `ciphertext` + metadata, NEVER plaintext. The client
 * decrypts `ciphertext` locally with the conversation's MLS state. `senderUserId` lets the UI attribute it;
 * `id` is the server's stable id used to dedup across fetch + sync (+ WS in 5C).
 */
export interface FetchedMessage {
  id: string;
  senderUserId: string;
  clientMessageId: string;
  ciphertext: string;
  alg: string;
  epoch: number;
  attachmentObjectKey: string | null;
  createdAt: string;
}

/** One page of a conversation's history. `nextCursor` (a message id) feeds the next `after`; null ends it. */
export interface MessagePage {
  messages: FetchedMessage[];
  nextCursor: string | null;
}

/**
 * Fetch a page of a conversation's history, oldest-first (keyset on `(created_at, id)`). `after` is the
 * previous page's `nextCursor` (a message id); omit for the first page. The client decrypts each ciphertext
 * in order against the rehydrated MLS state. Throws on non-OK.
 */
export async function fetchMessages(
  conversationId: string,
  opts: { after?: string; limit?: number } = {},
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.after) params.set('after', opts.after);
  const qs = params.toString();
  const res = await apiFetch(
    `/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ''}`,
  );
  if (!res.ok) throw new Error(`GET /conversations/${conversationId}/messages → ${res.status}`);
  return (await res.json()) as MessagePage;
}

// --- Encrypted attachments (A3) ---------------------------------------------------------------------------
// The client encrypts the blob under a fresh content key, asks the server for a short-lived presigned SAS
// grant, then PUTs/GETs the CIPHERTEXT directly to/from blob storage. The server brokers grants + metadata
// only — it never sees the bytes or the content key. The SAS URLs are capabilities: never log or persist them.

/** A minted upload capability: the opaque object key to reference, plus a short-lived presigned PUT URL. */
export interface UploadGrant {
  objectKey: string;
  uploadUrl: string;
}

/** Mint an upload grant for an encrypted attachment in `conversationId` (caller must be a member). `byteSize`
 *  is the ciphertext length and is policy-capped server-side. */
export async function createUploadGrant(
  conversationId: string,
  byteSize: number,
): Promise<UploadGrant> {
  const res = await apiFetch('/attachments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, byteSize }),
  });
  if (!res.ok) throw new Error(`POST /attachments → ${res.status}`);
  return (await res.json()) as UploadGrant;
}

/** Mint a download grant (short-lived presigned GET URL) for an attachment the caller may read. */
export async function createDownloadGrant(objectKey: string): Promise<string> {
  const res = await apiFetch('/attachments/download-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey }),
  });
  if (!res.ok) throw new Error(`POST /attachments/download-url → ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/** Upload the ciphertext directly to the presigned S3 PUT URL. No provider-specific headers — the S3
 *  presigned URL binds the verb + object into its SigV4 signature. `uploadUrl` is a capability — never log it. */
export async function putAttachmentBlob(uploadUrl: string, ciphertext: Uint8Array): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    // Copy into a fresh ArrayBuffer-backed view: the crypto lib returns Uint8Array<ArrayBufferLike>, but a
    // fetch body needs Uint8Array<ArrayBuffer> (BufferSource).
    body: new Uint8Array(ciphertext),
  });
  if (!res.ok) throw new Error(`attachment PUT → ${res.status}`);
}

/** Download the ciphertext directly from the presigned S3 GET URL. `url` is a capability — never log it. */
export async function getAttachmentBlob(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment GET → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// NOTE: cross-conversation catch-up (`GET /sync`) lands with the WebSocket client in 5C (reconnect → /sync →
// dedup), where its caller lives. 5B back-fills per-conversation on open (fetchMessages), so /sync would be
// unused dead code here — added in 5C with its consumer + tests.
