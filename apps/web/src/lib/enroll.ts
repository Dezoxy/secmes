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
 * @param d2SignaturePublicKeyB64 - D2's signature public key (base64); verified against the
 *   claimed KeyPackage to catch server-key-swap MITM. Obtained from the enrollment record.
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

    // Claim one of D2's key packages for this conversation. The deviceId filter ensures only D2's
    // pool is depleted — other devices' packages are not burned as collateral.
    const packages = await claimAllKeyPackages(selfUserId, approvedDeviceId);
    const d2Claimed = packages.find((p) => p.deviceId === approvedDeviceId);
    if (!d2Claimed) continue; // pool exhausted — skip this conversation (best-effort)

    const d2Package = deserializeKeyPackage(d2Claimed.keyPackage);

    // Server-key-swap MITM defense: the claimed package's signature key must match the fingerprint
    // D1 verified during enrollment approval. A mismatch means the server returned a different key.
    const claimedKey = d2Package.leafNode.signaturePublicKey;
    if (
      claimedKey.length !== d2SigKeyBytes.length ||
      claimedKey.some((b, i) => b !== d2SigKeyBytes[i])
    ) {
      continue; // claimed key does not match approved fingerprint — skip
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let epochConflict = false;

      // Stage→post→apply→persist under the conversation lock (same lock as sendLiveMessage /
      // drainCommits). Release after each attempt so the drain (if needed) can re-acquire.
      await withLock(conversationLock(conversationId), async () => {
        const staged = await conversation.stageMembershipCommit({ add: [d2Package] });
        if (!staged.invite) throw new Error('enrollment add commit produced no Welcome');

        const inv = serializeInvite(staged.invite);

        // Persist staged BEFORE posting: if the app crashes after a successful POST but before
        // applyStaged/saveConversationState, the drain path (onSubscribed → drainCommits) re-syncs
        // from the server on next load. clientCommitId is fixed here so the PENDING_STORE slot can
        // verify which commit we sent (same pattern as conversations.ts multi-device path).
        const clientCommitId = crypto.randomUUID();
        const pendingBytes = conversation.serializeStaged(staged);
        await deps.keystore.saveStagedCommit(
          deps.device,
          conversationId,
          deps.sessionKey,
          pendingBytes,
          staged.epoch,
          clientCommitId,
        );
        pendingBytes.fill(0);

        try {
          await postCommit(conversationId, {
            clientCommitId,
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
            // Clear the pending slot and signal to drain outside the lock (drainCommits re-acquires).
            await deps.keystore.clearStagedCommit(conversationId);
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
        await deps.keystore.clearStagedCommit(conversationId);
      });

      if (epochConflict) {
        // Lock released — drain the winning commit so we can retry at the new epoch.
        // after discardStaged: conversation.epoch = E (pre-staged). The winning commit moved
        // the server to E+1, so we need to process the commit stored at epoch E.
        // afterEpoch is an exclusive lower bound: afterEpoch = E-1 fetches commits with epoch > E-1,
        // i.e. epoch E and higher (same pattern as processCommitEvent in messaging.ts).
        const epochBefore = conversation.epoch;
        await drainCommits(deps, conversationId, conversation, conversation.epoch - 1);
        if (conversation.epoch === epochBefore) {
          // No commits on the server — this is a legacy no-commit conversation (created via the
          // pre-B2 deliverWelcome path). postCommit's contiguity guard rejects epoch > 0 when
          // conversation_commits is empty. Skip without retrying; D2 has no history for it anyway.
          break;
        }
        continue;
      }
      break;
    }
  }
}
