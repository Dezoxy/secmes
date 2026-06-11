// Typed API helpers for the crypto-blind server. Request creation, auth headers, JSON parsing,
// Zod validation, and safe error classification live in `api-client.ts`.

import {
  BackupResponseSchema,
  ClaimedKeyPackageSchema,
  CreateConversationRequestSchema,
  CreatedConversationSchema,
  CreateDownloadGrantRequestSchema,
  CreateUploadGrantRequestSchema,
  DeliverWelcomeRequestSchema,
  DeliveredWelcomeSchema,
  DownloadGrantSchema,
  MeSchema,
  MessagePageSchema,
  PendingWelcomesSchema,
  PublishKeyPackagesRequestSchema,
  PublishKeyPackagesResponseSchema,
  RevokeKeyPackagesRequestSchema,
  RevokeKeyPackagesResponseSchema,
  SendConversationMessageRequestSchema,
  SentMessageSchema,
  StoreBackupRequestSchema,
  UploadGrantSchema,
  WelcomeMaterialSchema,
  type ClaimedKeyPackage as ContractClaimedKeyPackage,
  type CreatedConversation,
  type DeliverWelcomeRequest,
  type FetchedMessage as ContractFetchedMessage,
  type Me as ContractMe,
  type MessagePage as ContractMessagePage,
  type PendingWelcome as ContractPendingWelcome,
  type PublishKeyPackagesResponse,
  type RevokeKeyPackagesResponse,
  type SendConversationMessageRequest,
  type SentMessage as ContractSentMessage,
  type UploadGrant as ContractUploadGrant,
  type UserSummary as ContractUserSummary,
  type WelcomeMaterial as ContractWelcomeMaterial,
  UserDirectorySchema,
} from '@argus/contracts';
import { requestJson, requestStatus, unwrapApiResult } from './api-client';

export { apiFetch } from './api-client';

/** The verified profile the API returns from the token claims (after JIT provisioning). */
export type Me = ContractMe;

/**
 * Record the login (POST /auth/session → JIT-provisions the user + audits `auth.login`), then fetch
 * the profile. Both run under the Bearer token, so the server derives identity + tenant from the
 * verified claims only. Returns the profile; throws on a non-OK response.
 */
export async function establishSession(): Promise<Me> {
  unwrapApiResult(await requestStatus({ path: '/auth/session', method: 'POST' }));
  return unwrapApiResult(await requestJson({ path: '/me', responseSchema: MeSchema }));
}

/** Result of publishing one-time KeyPackages to the directory. */
export type PublishResult = PublishKeyPackagesResponse;

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
  return unwrapApiResult(
    await requestJson({
      path: '/devices/me/key-packages',
      method: 'POST',
      body: { signaturePublicKey, keyPackages },
      requestSchema: PublishKeyPackagesRequestSchema,
      responseSchema: PublishKeyPackagesResponseSchema,
    }),
  );
}

/** The directory's response to a revoke. */
export type RevokeResult = RevokeKeyPackagesResponse;

/**
 * Revoke (delete) this device's UNCLAIMED KeyPackages from the directory — called before re-provisioning a
 * cleared/restored device, so its now-unopenable old packages (whose one-time privates were discarded) can't
 * be claimed by a peer who'd then seal a Welcome this device can never open (device-provisioning §6, #20).
 * Server-side, this only affects the caller's OWN device (resolved from the verified user + this signature
 * key). Throws on non-OK — callers treat it as best-effort (the stale packages are an availability residual).
 */
export async function revokeKeyPackages(signaturePublicKey: string): Promise<RevokeResult> {
  return unwrapApiResult(
    await requestJson({
      path: '/devices/me/key-packages/revoke',
      method: 'POST',
      body: { signaturePublicKey },
      requestSchema: RevokeKeyPackagesRequestSchema,
      responseSchema: RevokeKeyPackagesResponseSchema,
    }),
  );
}

/** A tenant member as the directory exposes it — metadata only (no keys, no content). */
export type UserSummary = ContractUserSummary;

/** List active members of the caller's tenant (RLS-scoped, metadata only) — the contact picker source. */
export async function listUsers(limit = 50): Promise<UserSummary[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/users?limit=${encodeURIComponent(limit)}`,
      responseSchema: UserDirectorySchema,
    }),
  );
}

/** One of a peer's one-time KeyPackages, claimed from the directory to add them to a group. */
export type ClaimedKeyPackage = ContractClaimedKeyPackage;

/**
 * Claim ONE unclaimed one-time KeyPackage for `userId` (a peer in this tenant). One-time-use: the server
 * marks it claimed so no two conversations seal to the same package. The returned package is UNTRUSTED
 * until its safety number (#20) is verified out-of-band — a malicious server could substitute keys.
 * Throws a distinct error when the peer has no packages (404) so the UI can prompt to retry later.
 */
export async function claimKeyPackage(userId: string): Promise<ClaimedKeyPackage> {
  const result = await requestJson({
    path: `/users/${encodeURIComponent(userId)}/key-package/claim`,
    method: 'POST',
    responseSchema: ClaimedKeyPackageSchema,
  });
  if (!result.ok && result.error.status === 404) {
    throw new Error('this contact has no key packages available yet');
  }
  return unwrapApiResult(result);
}

/** Create a conversation with the given other members (the caller is added server-side). */
export async function createConversation(memberUserIds: string[]): Promise<CreatedConversation> {
  return unwrapApiResult(
    await requestJson({
      path: '/conversations',
      method: 'POST',
      body: { memberUserIds },
      requestSchema: CreateConversationRequestSchema,
      responseSchema: CreatedConversationSchema,
    }),
  );
}

/** The Welcome (+ ratchet tree) to deliver — opaque base64; the server stores and forwards it blind. */
export type DeliverWelcomeBody = DeliverWelcomeRequest;

/** Deliver an MLS Welcome sealing `conversationId` to the recipient's claimed device. Opaque to the server. */
export async function deliverWelcome(
  conversationId: string,
  body: DeliverWelcomeBody,
): Promise<{ welcomeId: string }> {
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/welcomes`,
      method: 'POST',
      body,
      requestSchema: DeliverWelcomeRequestSchema,
      responseSchema: DeliveredWelcomeSchema,
    }),
  );
}

/** A pending Welcome addressed to this device — metadata only (the sealed blobs are fetched separately). */
export type PendingWelcome = ContractPendingWelcome;

/** List this device's pending Welcomes (metadata only; RLS- + device-scoped on the server). */
export async function listWelcomes(deviceId: string, limit = 50): Promise<PendingWelcome[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/welcomes?deviceId=${encodeURIComponent(deviceId)}&limit=${encodeURIComponent(limit)}`,
      responseSchema: PendingWelcomesSchema,
    }),
  );
}

/** The opaque sealed join material for a Welcome (base64; the client deserializes + joins it). */
export type WelcomeMaterial = ContractWelcomeMaterial;

/**
 * Fetch a Welcome's sealed material. `proof` is the base64url Ed25519 FETCH proof-of-possession for this
 * device over (deviceId, welcomeId), so only the owning device can retrieve its join material. Opaque base64.
 */
export async function fetchWelcomeMaterial(
  welcomeId: string,
  deviceId: string,
  proof: string,
): Promise<WelcomeMaterial> {
  return unwrapApiResult(
    await requestJson({
      path: `/welcomes/${encodeURIComponent(welcomeId)}/material?deviceId=${encodeURIComponent(deviceId)}&proof=${encodeURIComponent(proof)}`,
      responseSchema: WelcomeMaterialSchema,
    }),
  );
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
  unwrapApiResult(
    await requestStatus({
      path: `/welcomes/${encodeURIComponent(welcomeId)}?deviceId=${encodeURIComponent(deviceId)}&proof=${encodeURIComponent(proof)}`,
      method: 'DELETE',
    }),
  );
}

/**
 * The send payload — opaque base64 `ciphertext` plus non-secret routing metadata. `clientMessageId` is the
 * per-(sender, conversation) idempotency key (a retry returns the same row, no double fan-out). The server
 * stores and forwards this blind; it never sees plaintext or keys.
 */
export type SendMessageBody = SendConversationMessageRequest;

/** The server's ack for a sent message. `deduplicated` = an idempotent retry matched an existing row. */
export type SentMessage = ContractSentMessage;

/** Send one MLS-encrypted message to a conversation. Idempotent on `clientMessageId`. Throws on non-OK. */
export async function sendMessage(
  conversationId: string,
  body: SendMessageBody,
): Promise<SentMessage> {
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/messages`,
      method: 'POST',
      body,
      requestSchema: SendConversationMessageRequestSchema,
      responseSchema: SentMessageSchema,
    }),
  );
}

/**
 * A message as the server returns it — opaque base64 `ciphertext` + metadata, NEVER plaintext. The client
 * decrypts `ciphertext` locally with the conversation's MLS state. `senderUserId` lets the UI attribute it;
 * `id` is the server's stable id used to dedup across fetch + sync (+ WS in 5C).
 */
export type FetchedMessage = ContractFetchedMessage;

/** One page of a conversation's history. `nextCursor` (a message id) feeds the next `after`; null ends it. */
export type MessagePage = ContractMessagePage;

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
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ''}`,
      responseSchema: MessagePageSchema,
    }),
  );
}

// --- Encrypted attachments (A3) ---------------------------------------------------------------------------
// The client encrypts the blob under a fresh content key, asks the server for a short-lived presigned SAS
// grant, then PUTs/GETs the CIPHERTEXT directly to/from blob storage. The server brokers grants + metadata
// only — it never sees the bytes or the content key. The SAS URLs are capabilities: never log or persist them.

/** A minted upload capability: the opaque object key to reference, plus a short-lived presigned PUT URL. */
export type UploadGrant = ContractUploadGrant;

/** Mint an upload grant for an encrypted attachment in `conversationId` (caller must be a member). `byteSize`
 *  is the ciphertext length and is policy-capped server-side. */
export async function createUploadGrant(
  conversationId: string,
  byteSize: number,
): Promise<UploadGrant> {
  return unwrapApiResult(
    await requestJson({
      path: '/attachments',
      method: 'POST',
      body: { conversationId, byteSize },
      requestSchema: CreateUploadGrantRequestSchema,
      responseSchema: UploadGrantSchema,
    }),
  );
}

/** Mint a download grant (short-lived presigned GET URL) for an attachment the caller may read. */
export async function createDownloadGrant(objectKey: string): Promise<string> {
  const grant = unwrapApiResult(
    await requestJson({
      path: '/attachments/download-url',
      method: 'POST',
      body: { objectKey },
      requestSchema: CreateDownloadGrantRequestSchema,
      responseSchema: DownloadGrantSchema,
    }),
  );
  return grant.url;
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

// --- Key backup (PUT/GET /backups/me) ---------------------------------------------------------------
// The server holds an opaque copy of the IDENTITY-ONLY recovery artifact (passphrase-sealed client-side
// before upload). The server never decrypts it — this is a convenience copy, not the source of truth.
// The local download (RecoveryPanel) is always performed first; the server upload is best-effort.

/**
 * Upload the identity-only sealed recovery artifact to the server (PUT /backups/me).
 * Caller must be authenticated; throws on non-OK.
 */
export async function storeBackup(artifact: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: '/backups/me',
      method: 'PUT',
      body: { backup: artifact },
      requestSchema: StoreBackupRequestSchema,
    }),
  );
}

/**
 * Fetch the server-stored sealed artifact (GET /backups/me).
 * Returns null when no backup is stored (404). Throws (classified message) on other non-OK responses.
 * The returned string is opaque — pass it directly to `restoreFromArtifact`. Mirrors the `claimKeyPackage`
 * 404 pattern so it reuses requestJson's network-error classification + response validation.
 */
export async function fetchBackup(): Promise<string | null> {
  const result = await requestJson({
    path: '/backups/me',
    responseSchema: BackupResponseSchema,
  });
  if (!result.ok) {
    if (result.error.status === 404) return null;
    return unwrapApiResult(result); // throws a classified message (never reached for 404)
  }
  return result.data.backup;
}
