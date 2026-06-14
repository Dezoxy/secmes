import { seconds } from '@nestjs/throttler';

// Per-VERIFIED-USER rate limits (the guard keys on tenant+sub, applied AFTER auth). A generous baseline so
// normal use is never touched, plus tighter caps on the abuse-prone AUTHENTICATED mutations the threat
// models flag: pool-drain on claim/publish/revoke (key-directory.md §3), backup drain (key-backup.md), and
// upload abuse (encrypted-attachments.md). Unauthenticated-flood protection is the edge's job (Caddy/WAF),
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
  /** Write abuse: each PUT stores/replaces a ≤64 KiB sealed blob (key-backup.md). */
  storeBackup: 12,
  /** Exfil/brute-force-restore: bound repeated fetches of the sealed backup blob (key-backup.md §49). */
  fetchBackup: 20,
  /** Storage abuse: each grant authorizes a ≤10 MiB ciphertext upload (encrypted-attachments.md). */
  uploadGrant: 30,
  /** Presigned-URL minting: bound download-grant churn. Generous (attachments lazy-load) but < baseline;
   *  lower-risk than upload (read-only, membership-gated, no storage write) so the cap is looser. */
  downloadGrant: 60,
  /** Push subscription register/update/delete. Rare in practice; cap prevents registration thrashing. */
  subscribePush: 20,
  /** Admin device revoke — low cap; rare action, prevents bulk device purge floods. */
  adminDeviceRevoke: 12,
  /** Tenant creation — one per identity; 5/min hard cap prevents squatting floods. */
  createTenant: 5,
  /** Invite issuance — admin action; low cap prevents harvesting. */
  createInvite: 20,
  /** Invite acceptance — unbound user; brute-force protection for token guessing (256-bit entropy makes
   *  it infeasible, but the cap adds a second layer at negligible cost). */
  acceptInvite: 10,
  /** SSO config creation — admin; 5/min caps Zitadel org provisioning storms. */
  createSsoConfig: 5,
  /** SSO config update — admin; allows quick iteration on settings. */
  updateSsoConfig: 10,
  /** SSO secret rotation — admin; low cap prevents credential churn abuse. */
  rotateSsoSecret: 5,
  /** SSO config deletion — admin; Zitadel org teardown; low cap. */
  deleteSsoConfig: 5,
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
} as const;
