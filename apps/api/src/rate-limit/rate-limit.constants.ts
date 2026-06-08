import { seconds } from '@nestjs/throttler';

// Per-VERIFIED-USER rate limits (the guard keys on tenant+sub, with an IP fallback pre-auth). A generous
// baseline so normal use is never touched, plus tighter caps on the abuse-prone mutations the threat models
// flag: pool-drain on claim/publish/revoke (key-directory.md §3), backup drain (key-backup.md), upload abuse
// (encrypted-attachments.md), and login brute-force. Single-VM in-memory storage; a Redis store is the
// multi-instance / restart-safe upgrade (Redis is already wired for the realtime bus).
export const DEFAULT_THROTTLE = [{ name: 'default', ttl: seconds(60), limit: 120 }];

/** A tighter per-route override, applied via `@Throttle(perMinute(n))`. n requests per user per 60s. */
export const perMinute = (limit: number): Record<string, { ttl: number; limit: number }> => ({
  default: { ttl: seconds(60), limit },
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
} as const;
