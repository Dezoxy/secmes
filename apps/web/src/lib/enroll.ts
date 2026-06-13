// Enrollment fan-out driver (B2 — multi-device linking, Slice 6).
// Called by D1 after approving D2's enrollment to add D2 as an MLS leaf in every conversation D1
// participates in. Sequential, best-effort: one commit per conversation, one 409-rebase retry per
// commit. Skips conversations where D2 is already a member or D2's key-package pool is exhausted.

import { deserializeKeyPackage, serializeInvite, type Conversation } from '@argus/crypto';

import { CommitEpochConflictError, claimAllKeyPackages, postCommit } from './api';
import { fromBase64, toBase64 } from './base64';
import { conversationLock, withLock } from './locks';
import { drainCommits, type MessagingDeps } from './messaging';

const MAX_RETRIES = 2;

/**
 * Add D2 (the newly approved device) to every conversation in `conversationIds` that D2 isn't
 * already a leaf in.
 *
 * @param deps          - Messaging context for the approving device (D1).
 * @param selfUserId    - The shared user ID (same for D1 and D2).
 * @param approvedDeviceId  - Server-assigned UUID of D2 (from the enrollment record).
 * @param d2SignaturePublicKeyB64 - D2's signature public key (base64); used to detect if D2 is
 *   already a group member. Obtained from the claimed KeyPackage during the approval flow.
 * @param conversationIds - Conversation IDs to fan out into (from GET /devices/me/conversations).
 * @param liveGroups    - D1's currently loaded MLS group state (keyed by conversation ID).
 */
export async function enrollDevice(
  deps: MessagingDeps,
  selfUserId: string,
  approvedDeviceId: string,
  d2SignaturePublicKeyB64: string,
  conversationIds: string[],
  liveGroups: Map<string, Conversation>,
): Promise<void> {
  for (const conversationId of conversationIds) {
    const conversation = liveGroups.get(conversationId);
    if (!conversation) continue; // not live on D1 — skip (best-effort)

    // If D2 is already a leaf (e.g., added at epoch-0 via self-add), skip without claiming.
    const d2SigKeyBytes = fromBase64(d2SignaturePublicKeyB64);
    const d2AlreadyPresent = conversation.members().some((m) => {
      const mKey = m.signaturePublicKey;
      if (mKey.length !== d2SigKeyBytes.length) return false;
      for (let i = 0; i < mKey.length; i++) if (mKey[i] !== d2SigKeyBytes[i]) return false;
      return true;
    });
    if (d2AlreadyPresent) continue;

    // Claim one of D2's key packages for this conversation.
    const packages = await claimAllKeyPackages(selfUserId);
    const d2Claimed = packages.find((p) => p.deviceId === approvedDeviceId);
    if (!d2Claimed) continue; // pool exhausted — skip this conversation (best-effort)

    const d2Package = deserializeKeyPackage(d2Claimed.keyPackage);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let epochConflict = false;

      // Stage→post→apply→persist under the conversation lock (same lock as sendLiveMessage /
      // drainCommits). Release after each attempt so the drain (if needed) can re-acquire.
      await withLock(conversationLock(conversationId), async () => {
        const staged = await conversation.stageMembershipCommit({ add: [d2Package] });
        if (!staged.invite) throw new Error('enrollment add commit produced no Welcome');

        const inv = serializeInvite(staged.invite);

        try {
          await postCommit(conversationId, {
            clientCommitId: crypto.randomUUID(),
            epoch: staged.epoch,
            commit: toBase64(staged.commit),
            welcomes: [
              {
                recipientUserId: selfUserId,
                recipientDeviceId: approvedDeviceId,
                welcome: inv.welcome,
                ratchetTree: inv.ratchetTree,
              },
            ],
            // selfUserId is already a conversation_member (per-USER, not per-device); only the
            // Welcome routing to D2 matters here — no new user-level membership to add.
            addedUserIds: [],
            removedUserIds: [],
          });
        } catch (err) {
          conversation.discardStaged(staged);
          if (err instanceof CommitEpochConflictError && attempt < MAX_RETRIES - 1) {
            // Signal to drain outside the lock (drainCommits re-acquires the same lock).
            epochConflict = true;
            return;
          }
          throw err;
        }

        await conversation.applyStaged(staged);
        await deps.keystore.saveConversationState(
          deps.device,
          conversationId,
          conversation,
          deps.sessionKey,
        );
      });

      if (epochConflict) {
        // Lock released — drain the winning commit so we can retry at the new epoch.
        // conversation.epoch (after discardStaged) = staged epoch E; the winning commit moved
        // the server to E+1, so maxEpoch = E+1 = conversation.epoch + 1 (same pattern as onCommit).
        await drainCommits(deps, conversationId, conversation, conversation.epoch + 1);
        continue;
      }
      break;
    }
  }
}
