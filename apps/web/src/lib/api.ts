// Typed API helpers for the crypto-blind server. Request creation, auth headers, JSON parsing,
// Zod validation, and safe error classification live in `api-client.ts`.

import {
  AccessTokenResponseSchema,
  BreakglassLoginRequestSchema,
  ClaimedKeyPackageSchema,
  CommitBodySchema,
  CommitPageSchema,
  CommitResponseSchema,
  ConversationListSchema,
  ConversationMemberSchema,
  ConversationReceiptsSchema,
  CreateConversationRequestSchema,
  CreateDownloadGrantRequestSchema,
  CreateInviteResponseSchema,
  CreateUploadGrantRequestSchema,
  CreatedConversationSchema,
  DeliverWelcomeRequestSchema,
  DeliveredWelcomeSchema,
  DownloadGrantSchema,
  AdminAuditResponseSchema,
  AuthenticateOptionsResponseSchema,
  DeviceSummarySchema,
  EnrollmentApproveBodySchema,
  EnrollmentRegisterBodySchema,
  EnrollmentSchema,
  MeSchema,
  MemberSummarySchema,
  MessagePageSchema,
  PendingWelcomesSchema,
  PublishKeyPackagesRequestSchema,
  PublishKeyPackagesResponseSchema,
  RedeemCodeRequestSchema,
  RedeemCodeResponseSchema,
  RecordReceiptRequestSchema,
  RegisterOptionsRequestSchema,
  RegisterOptionsResponseSchema,
  RegisterVerifyRequestSchema,
  AuthenticateVerifyRequestSchema,
  RevokeKeyPackagesRequestSchema,
  RevokeKeyPackagesResponseSchema,
  SendConversationMessageRequestSchema,
  SentMessageSchema,
  SubscribePushRequestSchema,
  UpdateProfileSchema,
  InviteSummarySchema,
  UploadGrantSchema,
  UserLookupResultSchema,
  WelcomeMaterialSchema,
  WithdrawDeviceBodySchema,
  type AccessTokenResponse,
  type AuthenticateOptionsResponse,
  type ClaimedKeyPackage as ContractClaimedKeyPackage,
  type CommitBody as ContractCommitBody,
  type CommitPage as ContractCommitPage,
  type CommitResponse as ContractCommitResponse,
  type ConversationMember as ContractConversationMember,
  type ConversationReceipt as ContractConversationReceipt,
  type CreateInviteResponse as ContractCreateInviteResponse,
  type CreatedConversation,
  type AdminAuditResponse as ContractAdminAuditResponse,
  type AuditEventSummary as ContractAuditEventSummary,
  type DeviceSummary as ContractDeviceSummary,
  type FetchedCommit as ContractFetchedCommit,
  type UpdateProfile as ContractUpdateProfile,
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
  type UserLookupResult as ContractUserLookupResult,
  type WelcomeMaterial as ContractWelcomeMaterial,
  type Enrollment as ContractEnrollment,
  type ConversationList as ContractConversationList,
  type ConversationSummary as ContractConversationSummary,
  FriendListResponseSchema,
  FriendRequestListResponseSchema,
  SendFriendRequestSchema,
  SendFriendRequestResponseSchema,
  type Friend,
  type FriendRequest,
  type FriendRequestBox,
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

// ── Passkey authentication (Phase 5 frontend wiring) ─────────────────────────

/** Redeem an admin invite code (POST /auth/register/redeem → { ceremonyId }). */
export async function redeemCode(code: string): Promise<{ ceremonyId: string }> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/register/redeem',
      method: 'POST',
      body: { code },
      requestSchema: RedeemCodeRequestSchema,
      responseSchema: RedeemCodeResponseSchema,
    }),
  );
}

/** Get WebAuthn creation options for the given ceremony (POST /auth/webauthn/register/options).
 * Returns the raw PublicKeyCredentialCreationOptions JSON to pass to startRegistration(). */
export async function getRegisterOptions(ceremonyId: string): Promise<Record<string, unknown>> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/webauthn/register/options',
      method: 'POST',
      body: { ceremonyId },
      requestSchema: RegisterOptionsRequestSchema,
      responseSchema: RegisterOptionsResponseSchema,
    }),
  );
}

/** Submit a WebAuthn attestation to complete registration (POST /auth/webauthn/register/verify). */
export async function verifyRegistration(
  ceremonyId: string,
  registrationResponse: unknown,
): Promise<AccessTokenResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/webauthn/register/verify',
      method: 'POST',
      body: { ceremonyId, registrationResponse },
      requestSchema: RegisterVerifyRequestSchema,
      responseSchema: AccessTokenResponseSchema,
    }),
  );
}

/** Get WebAuthn authentication options (POST /auth/webauthn/authenticate/options). */
export async function getAuthenticateOptions(): Promise<AuthenticateOptionsResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/webauthn/authenticate/options',
      method: 'POST',
      responseSchema: AuthenticateOptionsResponseSchema,
    }),
  );
}

/** Submit a WebAuthn assertion to complete login (POST /auth/webauthn/authenticate/verify). */
export async function verifyAuthentication(
  ceremonyId: string,
  authenticationResponse: unknown,
): Promise<AccessTokenResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/webauthn/authenticate/verify',
      method: 'POST',
      body: { ceremonyId, authenticationResponse },
      requestSchema: AuthenticateVerifyRequestSchema,
      responseSchema: AccessTokenResponseSchema,
    }),
  );
}

/**
 * Rotate the refresh cookie → new access token (POST /auth/session/refresh).
 * Sends the `argus_refresh` HttpOnly cookie automatically; requires `X-Argus-Refresh: 1` as CSRF guard.
 * No Bearer token needed — the cookie carries the credential.
 */
export async function refreshSession(): Promise<AccessTokenResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/session/refresh',
      method: 'POST',
      headers: { 'X-Argus-Refresh': '1' },
      responseSchema: AccessTokenResponseSchema,
    }),
  );
}

/** Revoke the current session and clear the refresh cookie (POST /auth/session/logout). */
export async function logoutSession(): Promise<void> {
  unwrapApiResult(await requestStatus({ path: '/auth/session/logout', method: 'POST' }));
}

/** Authenticate as the breakglass admin (POST /auth/breakglass/login). */
export async function breakglassLogin(
  username: string,
  password: string,
): Promise<AccessTokenResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/auth/breakglass/login',
      method: 'POST',
      body: { username, password },
      requestSchema: BreakglassLoginRequestSchema,
      responseSchema: AccessTokenResponseSchema,
    }),
  );
}

// ── User discovery (Phase 4 + 5) ─────────────────────────────────────────────

/** A user found by exact argus-id lookup — metadata only. */
export type UserLookupResult = ContractUserLookupResult;

/** Exact-match lookup by argus-id (GET /users/lookup). Returns null when not found. */
export async function lookupUserByArgusId(argusId: string): Promise<UserLookupResult | null> {
  const result = await requestJson({
    path: `/users/lookup?argusId=${encodeURIComponent(argusId)}`,
    responseSchema: UserLookupResultSchema,
  });
  if (!result.ok && result.status === 404) return null;
  return unwrapApiResult(result);
}

/** A member of a conversation — metadata only. */
export type ConversationMember = ContractConversationMember;

/** List the members of a conversation (GET /conversations/:id/members). */
export async function getConversationMembers(
  conversationId: string,
): Promise<ConversationMember[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/members`,
      responseSchema: ConversationMemberSchema.array(),
    }),
  );
}

// ── Profile editing (Phase 4 + 5) ────────────────────────────────────────────

/** Update the caller's display name and/or avatar seed (PUT /me → 204). */
export type UpdateProfileBody = ContractUpdateProfile;

export async function updateProfile(body: UpdateProfileBody): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: '/me',
      method: 'PUT',
      body,
      requestSchema: UpdateProfileSchema,
    }),
  );
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
export async function createConversation(
  memberUserIds: string[],
  isDirect: boolean,
): Promise<CreatedConversation> {
  return unwrapApiResult(
    await requestJson({
      path: '/conversations',
      method: 'POST',
      body: { memberUserIds, isDirect },
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

// --- MLS group commits (POST/GET /conversations/:id/commits) ----------------------------------------
// Epoch-locked commit fan-out. First POST wins the epoch slot (200); a concurrent POST at the same epoch
// loses (409 — the client rebases). Metadata only on the WS push; full bytes fetched via GET.

/** The commit body — opaque ciphertext + declared membership delta + per-device Welcomes. */
export type CommitBody = ContractCommitBody;

/** Server ack for a commit POST (first win or own idempotent retry). */
export type CommitResponse = ContractCommitResponse;

/** A commit row as returned by GET /commits — ciphertext + epoch metadata. */
export type FetchedCommit = ContractFetchedCommit;

/** An array of commits, ordered by epoch ascending. */
export type CommitPage = ContractCommitPage;

/**
 * Thrown by `postCommit` when another member already won the epoch slot (409).
 * The caller should discard the staged commit and rebase from the new epoch.
 */
export class CommitEpochConflictError extends Error {
  constructor() {
    super('epoch slot already claimed by another member — discard staged and rebase');
    this.name = 'CommitEpochConflictError';
  }
}

/**
 * Submit a staged MLS commit (POST /conversations/:id/commits). First caller wins the epoch slot (200).
 * Throws `CommitEpochConflictError` if another member won (409). Own idempotent retry returns 200
 * with `deduplicated: true`. Server applies the declared membership delta server-side.
 */
export async function postCommit(
  conversationId: string,
  body: CommitBody,
): Promise<CommitResponse> {
  const result = await requestJson({
    path: `/conversations/${encodeURIComponent(conversationId)}/commits`,
    method: 'POST',
    body,
    requestSchema: CommitBodySchema,
    responseSchema: CommitResponseSchema,
  });
  if (!result.ok && result.error.status === 409) throw new CommitEpochConflictError();
  return unwrapApiResult(result);
}

/**
 * Fetch commits after `afterEpoch` in ascending epoch order (GET /conversations/:id/commits).
 * Used by the commit drain state machine to catch up after a commit event or reconnect.
 */
export async function listCommits(
  conversationId: string,
  opts: { afterEpoch?: number; limit?: number } = {},
): Promise<FetchedCommit[]> {
  const params = new URLSearchParams();
  if (opts.afterEpoch !== undefined) params.set('afterEpoch', String(opts.afterEpoch));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return unwrapApiResult(
    await requestJson({
      path: `/conversations/${encodeURIComponent(conversationId)}/commits${qs ? `?${qs}` : ''}`,
      responseSchema: CommitPageSchema,
    }),
  );
}

/**
 * Claim one unclaimed KeyPackage per device of `userId` (POST /users/:userId/key-packages/claim-all).
 * Used for group adds — each device of the new member needs its own Welcome. Returns an empty array
 * if the user has no devices or all pools are empty.
 */
export async function claimAllKeyPackages(
  userId: string,
  deviceId?: string,
  excludeDeviceId?: string,
): Promise<ClaimedKeyPackage[]> {
  const params = new URLSearchParams();
  if (deviceId) params.set('deviceId', deviceId);
  if (excludeDeviceId) params.set('excludeDeviceId', excludeDeviceId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return unwrapApiResult(
    await requestJson({
      path: `/users/${encodeURIComponent(userId)}/key-packages/claim-all${qs}`,
      method: 'POST',
      responseSchema: ClaimedKeyPackageSchema.array(),
    }),
  );
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

// ── Tenant invites + members (admin) ─────────────────────────────────────────

export type CreateInviteResponse = ContractCreateInviteResponse;
export type InviteSummary = ContractInviteSummary;
export type MemberSummary = ContractMemberSummary;

// ── G3: admin panel ───────────────────────────────────────────────────────────

export type DeviceSummary = ContractDeviceSummary;
export type AuditEventSummary = ContractAuditEventSummary;
export type AdminAuditResponse = ContractAdminAuditResponse;

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
 * Create a single-use invite/registration code for this tenant (POST /tenants/invites → 201).
 * Returns the plaintext token — shown once, never stored.
 */
export async function createInvite(): Promise<CreateInviteResponse> {
  return unwrapApiResult(
    await requestJson({
      path: '/tenants/invites',
      method: 'POST',
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

/** List all devices in the tenant (admin only). */
export async function listAdminDevices(): Promise<DeviceSummary[]> {
  return unwrapApiResult(
    await requestJson({
      path: '/admin/devices',
      method: 'GET',
      responseSchema: DeviceSummarySchema.array(),
    }),
  );
}

/** Hard-delete a device (admin only, cascades key packages). */
export async function adminRevokeDevice(deviceId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/admin/devices/${encodeURIComponent(deviceId)}`,
      method: 'DELETE',
    }),
  );
}

/** Paginated audit log, newest first (admin only). */
export async function listAdminAudit(cursor?: string, limit = 50): Promise<AdminAuditResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return unwrapApiResult(
    await requestJson({
      path: `/admin/audit?${params.toString()}`,
      method: 'GET',
      responseSchema: AdminAuditResponseSchema,
    }),
  );
}

// ── Device enrollment (B2 — multi-device linking) ───────────────────────────

export type Enrollment = ContractEnrollment;
export type ConversationList = ContractConversationList;
export type ConversationSummary = ContractConversationSummary;

/** D2 registers a pending enrollment request (shows its fingerprint for D1 to verify). */
export async function registerEnrollment(
  deviceId: string,
  fingerprint: string,
): Promise<Enrollment> {
  return unwrapApiResult(
    await requestJson({
      path: '/devices/me/enrollment',
      method: 'POST',
      body: { deviceId, fingerprint },
      requestSchema: EnrollmentRegisterBodySchema,
      responseSchema: EnrollmentSchema,
    }),
  );
}

/** D1 lists its pending (or resolved) enrollment requests. */
export async function listEnrollments(status = 'pending'): Promise<Enrollment[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/devices/enrollments?status=${encodeURIComponent(status)}`,
      responseSchema: EnrollmentSchema.array(),
    }),
  );
}

/** D1 approves D2's enrollment with an Ed25519 enroll-proof. */
export async function approveEnrollment(
  enrollmentId: string,
  approvingDeviceId: string,
  proof: string,
): Promise<Enrollment> {
  return unwrapApiResult(
    await requestJson({
      path: `/devices/enrollments/${encodeURIComponent(enrollmentId)}/approve`,
      method: 'POST',
      body: { approvingDeviceId, proof },
      requestSchema: EnrollmentApproveBodySchema,
      responseSchema: EnrollmentSchema,
    }),
  );
}

/** D1 rejects D2's enrollment. */
export async function rejectEnrollment(enrollmentId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/devices/enrollments/${encodeURIComponent(enrollmentId)}/reject`,
      method: 'POST',
    }),
  );
}

/**
 * Permanently delete this device's server row (cascades to key packages). Used by the legacy
 * pre-B2 migration to remove the old bare-userId device row so the new composite-identity device
 * is published as non-provisional. Idempotent — no-ops if the device is already gone.
 */
export async function withdrawDevice(signaturePublicKey: string, proof: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: '/devices/me/withdraw',
      method: 'POST',
      body: { signaturePublicKey, proof },
      requestSchema: WithdrawDeviceBodySchema,
    }),
  );
}

/**
 * Atomically migrate the legacy bare-userId device to a composite-identity device: deletes the
 * existing device row and re-inserts it as non-provisional in one transaction, closing the race
 * window that withdrawDevice + publishKeyPackages leaves open. Use instead of withdrawDevice during
 * the pre-B2 → B2 identity migration.
 */
export async function migrateDevice(signaturePublicKey: string, proof: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: '/devices/me/migrate',
      method: 'POST',
      body: { signaturePublicKey, proof },
      requestSchema: WithdrawDeviceBodySchema,
    }),
  );
}

/** Return the caller's conversation IDs (for enrollment fan-out diff). */
export async function listMyConversations(): Promise<string[]> {
  return unwrapApiResult(
    await requestJson<ConversationList>({
      path: '/devices/me/conversations',
      responseSchema: ConversationListSchema,
    }),
  ).conversations.map((c) => c.id);
}

/** Return the caller's conversations with type metadata (for roster recovery after reinstall). */
export async function listMyConversationsWithMeta(): Promise<ConversationSummary[]> {
  return unwrapApiResult(
    await requestJson<ConversationList>({
      path: '/devices/me/conversations',
      responseSchema: ConversationListSchema,
    }),
  ).conversations;
}

// ── Friends (Slice D API — contact-list recovery) ─────────────────────────────

export type { Friend, FriendRequest, FriendRequestBox };

/** List accepted friends (GET /friends). The durable contact-recovery source. */
export async function listFriends(): Promise<Friend[]> {
  return unwrapApiResult(
    await requestJson({ path: '/friends', responseSchema: FriendListResponseSchema }),
  ).friends;
}

/** List pending friend requests for one mailbox (GET /friends/requests?box=). */
export async function listFriendRequests(box: FriendRequestBox): Promise<FriendRequest[]> {
  return unwrapApiResult(
    await requestJson({
      path: `/friends/requests?box=${encodeURIComponent(box)}`,
      responseSchema: FriendRequestListResponseSchema,
    }),
  ).requests;
}

/** Send a friend request by argus-id (POST /friends/requests). Always returns 202 (uniform — no oracle). */
export async function sendFriendRequest(argusId: string): Promise<{ status: 'accepted' }> {
  return unwrapApiResult(
    await requestJson({
      path: '/friends/requests',
      method: 'POST',
      body: { argusId },
      requestSchema: SendFriendRequestSchema,
      responseSchema: SendFriendRequestResponseSchema,
      expectedStatuses: [202],
    }),
  );
}

/** Accept an incoming friend request (POST /friends/requests/:id/accept → 204). */
export async function acceptFriendRequest(requestId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/friends/requests/${encodeURIComponent(requestId)}/accept`,
      method: 'POST',
    }),
  );
}

/** Decline an incoming friend request — hard DELETE (POST /friends/requests/:id/decline → 204). */
export async function declineFriendRequest(requestId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/friends/requests/${encodeURIComponent(requestId)}/decline`,
      method: 'POST',
    }),
  );
}

/** Cancel an outgoing friend request — hard DELETE (DELETE /friends/requests/:id → 204). */
export async function cancelFriendRequest(requestId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({
      path: `/friends/requests/${encodeURIComponent(requestId)}`,
      method: 'DELETE',
    }),
  );
}

// TODO(Slice F): wire to ConversationList "Remove friend" action.
/** Remove an accepted friend (DELETE /friends/:userId → 204). */
export async function unfriend(userId: string): Promise<void> {
  unwrapApiResult(
    await requestStatus({ path: `/friends/${encodeURIComponent(userId)}`, method: 'DELETE' }),
  );
}
