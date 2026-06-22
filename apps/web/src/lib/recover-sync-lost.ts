// Track 4 slice 5c — recovery driver for a conversation flagged "sync-lost" by the 5b detector.
//
// A conversation is "sync-lost" when the MLS commit needed to advance its epoch has been pruned (or
// the device was offline beyond retention): `classifyCommitDrain` proved that retrying can NEVER
// close the gap (it only returns 'sync-lost' when oldestRetainedEpoch > localEpoch). Before 5c the
// device spun forever; 5b made it stop and report.
//
// A stranded device CANNOT re-add itself. Re-add is a member-authorized MLS add commit, and the
// server enforces `requireMembership` on the commit/Welcome post — only a current member at the live
// epoch can produce a fresh Welcome. So the only recovery that preserves the crypto-blind boundary
// (and adds no new server state or crypto surface) is: drop the broken local group state and re-drive
// the EXISTING Welcome drain, making this device re-addable. If/when a current member issues a fresh
// add (the user's own live sibling device, or the peer's device), this device re-joins FRESH at the
// current epoch through the unchanged, fully-verified `joinPendingConversations` path — same
// out-of-band safety-number check, a fresh one-time KeyPackage, no key reuse.
//
// ACTIVE cross-device re-add (proactively pushing a fresh Welcome to a stranded sibling) is DEFERRED
// (slice 5c-2, gated on group-chat GA): it needs either new server state — a cross-device "I'm
// stranded" signal, the published-GroupInfo surface the threat model rules out — or the MLS
// remove+add (PCS) path, which the crypto wrapper does not implement yet. v1 is self-heal only.

import type { Conversation as MlsGroup } from '@argus/crypto';

import type { DeviceKeystore } from './keystore';

/**
 * Recover a sync-lost conversation by clearing its broken local MLS state and re-driving the Welcome
 * drain so the device becomes re-addable. Best-effort: never throws into the caller.
 *
 * Clears ONLY the sealed group ratchet state (`deleteConversationState` deletes the GROUP_STORE record
 * + its CAS version). The decrypted message history (MSGLOG_STORE) and the verified-peer trust records
 * (VERIFIED_PEERS_STORE) live in SEPARATE stores and are deliberately preserved — so local history
 * survives a reload and a clean re-join re-checks the SAME stored safety numbers (restoring the badge
 * on an unchanged key, warning on a changed one).
 *
 * Safe by construction: the device is already stuck (sync-lost ⇒ the commit it needs is provably gone),
 * so its stale ratchet holds no recoverable future and discarding it loses nothing the device could
 * ever have used. A removed device gains nothing — it still has no member to add it back.
 *
 * @param keystore        - the sealed device keystore (holds the per-conversation group state).
 * @param conversationId  - the sync-lost conversation (metadata only; never logged with content).
 * @param liveGroups      - the in-memory MLS group map; the broken group is dropped so no live path
 *                          (catch-up / commit drain) keeps operating on a ratchet that can't advance.
 * @param redrainWelcomes - re-drive the existing Welcome drain (idempotent) so a fresh Welcome that is
 *                          already pending — or arrives next — is picked up and re-joins at once.
 */
export async function recoverSyncLost(
  keystore: DeviceKeystore,
  conversationId: string,
  liveGroups: Map<string, MlsGroup>,
  redrainWelcomes: () => void,
): Promise<void> {
  try {
    // Drop the in-memory group FIRST so any concurrent live handler (a racing catch-up / commit drain)
    // sees no group and short-circuits, rather than operating on a ratchet we are about to invalidate.
    liveGroups.delete(conversationId);
    await keystore.deleteConversationState(conversationId);
    // Now that no durable group state remains, the join drain's `hasConversationState` gate is false,
    // so a fresh Welcome for this conversation will be joined + persisted instead of skipped as a replay.
    redrainWelcomes();
  } catch (err) {
    // Recovery is best-effort: a later reconnect re-runs the drain anyway. Log id-only — never content
    // or keys (invariant #2). Constant format string; the id is a separate arg (semgrep unsafe-formatstring).
    // eslint-disable-next-line no-console
    console.warn(
      'sync-lost recovery failed',
      conversationId,
      err instanceof Error ? err.message : err,
    );
  }
}
