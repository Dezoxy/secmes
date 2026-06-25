import { seconds } from '@nestjs/throttler';

// Per-VERIFIED-USER rate limits (the guard keys on tenant+sub, applied AFTER auth). A generous baseline so
// normal use is never touched, plus tighter caps on the abuse-prone AUTHENTICATED mutations the threat
// models flag: pool-drain on claim/publish/revoke (key-directory.md §3) and upload abuse
// (encrypted-attachments.md). Unauthenticated-flood protection is the edge's job (Caddy/WAF),
// not this guard's — see rate-limiting.md §6. Single-VM in-memory storage; a Redis store is the
// multi-instance / restart-safe upgrade (Redis is already wired for the realtime bus).
export const DEFAULT_THROTTLE = [{ name: 'default', ttl: seconds(60), limit: 120 }];

/** A tighter per-route override, applied via `@Throttle(perMinute(n))`. n requests per user per 60s. */
export const perMinute = (limit: number): Record<string, { ttl: number; limit: number }> => ({
  default: { ttl: seconds(60), limit },
});

/** Per-route override: n requests per user per hour (3 600 s). */
export const perHour = (limit: number): Record<string, { ttl: number; limit: number }> => ({
  default: { ttl: seconds(3600), limit },
});

/** Per-route override: n requests per user per day (86 400 s). */
export const perDay = (limit: number): Record<string, { ttl: number; limit: number }> => ({
  default: { ttl: seconds(86400), limit },
});

// Tighter caps for the abuse-prone mutations the threat models flag. Each is well above any legitimate
// human burst but far below what a drain/flood attack needs. Keyed per verified user, so one tenant/user
// can't spend another's budget. Numbers live here (not inline) so the threat model and the guard test
// reference one source of truth.
export const SENSITIVE_LIMITS = {
  /** Pool-drain: claiming consumes a victim's one-time-use KeyPackages (key-directory.md §3). */
  claimKeyPackage: 30,
  /** Storage flood: each publish inserts up to 100 KeyPackage rows (key-directory.md). */
  publishKeyPackages: 12,
  /** Own-device mutation; idempotent, but still a write — cap the hammering (key-directory.md). */
  revokeKeyPackages: 12,
  /** Storage abuse: each grant authorizes a ≤10 MiB ciphertext upload (encrypted-attachments.md). */
  uploadGrant: 30,
  /** Presigned-URL minting: bound download-grant churn. Generous (attachments lazy-load) but < baseline;
   *  lower-risk than upload (read-only, membership-gated, no storage write) so the cap is looser. */
  downloadGrant: 60,
  /** Push subscription register/update/delete. Rare in practice; cap prevents registration thrashing. */
  subscribePush: 20,
  /** Admin device revoke — low cap; rare action, prevents bulk device purge floods. */
  adminDeviceRevoke: 12,
  /** Invite/registration-code issuance — admin action; low cap prevents harvesting. */
  createInvite: 20,
  /** DSAR export — heavy parallel DB read; tight cap discourages scraping. Per hour, not per minute. */
  exportMyData: 2,
  /** Account deletion — irreversible cascade; low cap prevents accidental hammering. Per day. */
  deleteAccount: 3,
  /** Enrollment register — D2 registers a pending link request. Low: infrequent, and DoS T4 mitigation. */
  enrollmentRegister: 5,
  /** Enrollment approve/reject — D1 approves or rejects. Low: rare human action. */
  enrollmentApprove: 10,
  /** Enrollment list — D1 polls pending requests. Moderate: UI may poll while waiting. */
  enrollmentList: 30,
  /** Conversation list for fan-out diff — D1 fetches its conversation IDs after approval. */
  enrollmentConversationList: 30,
  /** Self device withdrawal — legacy migration or explicit device removal. Very rare; tight cap. */
  deviceWithdraw: 5,
  /** Refresh token rotation — @Public(), keyed on IP (the only server-verified key before auth).
   *  Set high enough for NAT-shared IPs (60 offices-users refreshing concurrently ≪ 60/min) while
   *  still bounding DB flood from a runaway client. Reuse detection (family revocation) is the real
   *  security control; this limit is a DB-load guard only. */
  refreshSession: 60,
  /** Passkey invite-code redemption — @Public(), IP-keyed. 256-bit CSPRNG code makes brute-force
   *  infeasible; this cap is a heavy-path DoS guard only. */
  passkeyRedeem: 10,
  /** Passkey authentication (options + verify) — @Public(), IP-keyed. Discoverable login has no
   *  enumeration oracle (empty allowCredentials); cap is a DB-load guard only. */
  passkeyAuthenticate: 30,
  /** Breakglass admin login — @Public(), IP-keyed. Lockout (N=5/15 min) is the real security
   *  control; this cap is a heavy-path DoS guard (64 MiB Argon2id per attempt). */
  breakglassLogin: 10,
  /** Credential minting is cheap but a leaked-creds farm shouldn't be free; generous for retry. */
  turnCredentials: 30,
  /** Exact argus-id lookup — anti-enumeration guard. Exact-match-only is the real control;
   *  this cap makes bulk scanning visible in logs and expensive. */
  lookupUser: 10,
  /** Profile update (displayName / avatarSeed) — prevents bulk display-name churn. */
  updateProfile: 20,
  /** Privacy settings update — prevents bulk preference-churn. */
  updatePrivacySettings: 20,
  /** Send a friend request — a STATE-CHANGING argus-id probe (R-friends-3). Tighter than lookupUser
   *  and applied per HOUR (perHour), distinct from the read budget so a normal add-burst can't exhaust
   *  lookups and vice versa. The uniform 202 is the real anti-oracle control; this caps bulk scanning. */
  sendFriendRequest: 10,
  /** Friend request action (accept / decline / cancel / unfriend) — bounded write hammering. */
  friendsAction: 30,
  /** Friends + open-requests listing — moderate; the UI may refresh these views. */
  friendsList: 30,
} as const;
