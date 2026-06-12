// Typed API helpers for the crypto-blind server. Request creation, auth headers, JSON parsing,
// Zod validation, and safe error classification live in `api-client.ts`.

import {
  AcceptInviteBodySchema,
  BackupResponseSchema,
  ClaimedKeyPackageSchema,
  ConversationReceiptsSchema,
  CreateConversationRequestSchema,
  CreateInviteBodySchema,
  CreateInviteResponseSchema,
  CreateTenantBodySchema,
  CreateTenantResponseSchema,
  CreatedConversationSchema,
  CreateDownloadGrantRequestSchema,
  CreateUploadGrantRequestSchema,
  DeliverWelcomeRequestSchema,
  DeliveredWelcomeSchema,
  DownloadGrantSchema,
  InviteSummarySchema,
  MeSchema,
  MemberSummarySchema,
  MessagePageSchema,
  PendingWelcomesSchema,
  PublishKeyPackagesRequestSchema,
  PublishKeyPackagesResponseSchema,
  RecordReceiptRequestSchema,
  RevokeKeyPackagesRequestSchema,
  RevokeKeyPackagesResponseSchema,
  SendConversationMessageRequestSchema,
  SentMessageSchema,
  StoreBackupRequestSchema,
  SubscribePushRequestSchema,
  UploadGrantSchema,
  WelcomeMaterialSchema,
  type ClaimedKeyPackage as ContractClaimedKeyPackage,
  type ConversationReceipt as ContractConversationReceipt,
  type CreateInviteResponse as ContractCreateInviteResponse,
  type CreateTenantResponse as ContractCreateTenantResponse,
  type CreatedConversation,
  type InviteSummary as ContractInviteSummary,
  type MemberSummary as ContractMemberSummary,
  type ReceiptStatus,
  type DeliverWelcomeRequest,
  type FetchedMessage as ContractFetchedMessage,
  type Me as ContractMe,
  type MeBound as ContractMeBound,
  type MessagePage as ContractMessagePage,
  type PendingWelcome as ContractPendingWelcome,
  type PublishKeyPackagesResponse,
  type RevokeKeyPackagesResponse,
  type SendConversationMessageRequest,
  type SentMessage as ContractSentMessage,
  type SubscribePushRequest,
  type UploadGrant as ContractUploadGrant,
  type UserSummary as ContractUserSummary,
  type WelcomeMaterial as ContractWelcomeMaterial,
  UserDirectorySchema,
} from '@argus/contracts';
import { requestJson, requestStatus, unwrapApiResult } from './api-client';

export { apiFetch } from './api-client';

/** The full discriminated-union /me response (bound or unbound). */
export type Me = ContractMe;
/** Narrowed /me response for a user already bound to a tenant. */
export type MeBound = ContractMeBound;

/** Fetch the caller's server profile (GET /me). Throws on non-OK. */
export async function fetchMe(): Promise<Me> {
  return unwrapApiResult(await requestJson({ path: '/me', responseSchema: MeSchema }));
}

/**
 * Record the login (POST /auth/session → JIT-provisions the user + audits `auth.login`), then fetch
 * the profile. Both run under the Bearer token, so the server derives identity + tenant from the
 * verified claims only. Returns the profile; throws on a non-OK response.
 */
export async function establishSession(): Promise<Me> {
  unwrapApiResult(await requestStatus({ path: '/auth/session', method: 'POST' }));
  return fetchMe();
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

// --- Delivery receipts (POST/GET /conversations/:id/receipts) ---------------------------------------
// Metadata only — a member id + a "through message id" + when. The server stores per-member high-water-
// marks and (checkpoint 31) fans an advance out over the `/ws` gateway so a sender's ticks flip live.

/** One member's delivered/read high-water-marks in a conversation. Watermarks are null until first ack. */
export type ConversationReceipt = ContractConversationReceipt;

/**
 * Advance the caller's OWN delivered/read watermark in a conversation (POST …/receipts → 204). The server
 * is monotonic (never rolls a watermark back) and authz is member-only. Throws on non-OK.
 */
export async function recordReceipt(
  conversationId: string,
  status: ReceiptStatus,
  throughMessageId: string,
): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/conversations/${encodeURIComponent(conversationId)}/receipts`,
      method: 'POST',
      body: { status, throughMessageId },
      requestSchema: RecordReceiptRequestSchema,
    }),
  );
}

/**
 * Fetch per-member delivered/read watermarks for a conversation (GET …/receipts). Used to SEED a sender's
 * tick state on opening a conversation (the live `receipt` WS frame refines it afterward). Throws on non-OK.
 */
export async function fetchReceipts(conversationId: string): Promise<ConversationReceipt[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/receipts`,
      responseSchema: ConversationReceiptsSchema,
    }),
  );
}

// --- Push subscriptions (PUT/DELETE /push/subscription) -----------------------------------------------
// Transport-level registration only — endpoint + RFC 8291 keys. No message content or E2E keys involved.
// The server stores these to fan content-free VAPID pings after a message is committed.

/** Register or update the push subscription for this device (PUT /push/subscription → 204). */
export async function savePushSubscription(req: SubscribePushRequest): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: '/push/subscription',
      method: 'PUT',
      body: req,
      requestSchema: SubscribePushRequestSchema,
    }),
  );
}

/** Remove the push subscription for this device (DELETE /push/subscription?deviceId=… → 204). */
export async function deletePushSubscription(deviceId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/push/subscription?deviceId=${encodeURIComponent(deviceId)}`,
      method: 'DELETE',
    }),
  );
}

// ── G1: self-serve tenant onboarding ──────────────────────────────────────────

export type CreateTenantResponse = ContractCreateTenantResponse;
export type CreateInviteResponse = ContractCreateInviteResponse;
export type InviteSummary = ContractInviteSummary;
export type MemberSummary = ContractMemberSummary;

/** Create a new tenant with the caller as the first admin (POST /tenants → 201). */
export async function createTenant(name: string): Promise<CreateTenantResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants',
      method: 'POST',
      body: { name },
      requestSchema: CreateTenantBodySchema,
      responseSchema: CreateTenantResponseSchema,
    }),
  );
}

/** Accept an invite by its one-time plaintext token (POST /tenants/invites/accept → 201). */
export async function acceptInvite(token: string): Promise<CreateTenantResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants/invites/accept',
      method: 'POST',
      body: { token },
      requestSchema: AcceptInviteBodySchema,
      responseSchema: CreateTenantResponseSchema,
    }),
  );
}

/** List active members of the caller's tenant (GET /tenants/members). */
export async function listMembers(): Promise<MemberSummary[]> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants/members',
      responseSchema: MemberSummarySchema.array(),
    }),
  );
}

/**
 * Create an invite for this tenant (POST /tenants/invites → 201).
 * Returns the plaintext token — shown once, never stored.
 */
export async function createInvite(inviteeEmail?: string): Promise<CreateInviteResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants/invites',
      method: 'POST',
      body: inviteeEmail ? { inviteeEmail } : {},
      requestSchema: CreateInviteBodySchema,
      responseSchema: CreateInviteResponseSchema,
    }),
  );
}

/** List pending (not accepted, not revoked, not expired) invites (GET /tenants/invites). */
export async function listInvites(): Promise<InviteSummary[]> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants/invites',
      responseSchema: InviteSummarySchema.array(),
    }),
  );
}

/** Revoke an invite (DELETE /tenants/invites/:id → 204). */
export async function revokeInvite(inviteId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/tenants/invites/${encodeURIComponent(inviteId)}`,
      method: 'DELETE',
    }),
  );
}

/** Change a member's role (PATCH /tenants/members/:userId/role → 204). */
export async function setMemberRole(userId: string, role: 'admin' | 'member'): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/tenants/members/${encodeURIComponent(userId)}/role`,
      method: 'PATCH',
      body: { role },
    }),
  );
}

/** Revoke (soft-delete) a member (DELETE /tenants/members/:userId → 204). */
export async function revokeMember(userId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/tenants/members/${encodeURIComponent(userId)}`,
      method: 'DELETE',
    }),
  );
}
