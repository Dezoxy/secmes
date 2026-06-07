// Join on connect (Slice 4, recipient side). When the device is unlocked + provisioned, drain its pending
// Welcomes: list → fetch (with a proof) → join with the matching retained private → consume (with a proof)
// → prune the used private (forward secrecy). Per-Welcome failures are isolated so one bad Welcome can't
// block the rest. Live send/fetch is Slice 5; here we only join + surface the conversation.

import {
  MlsEngine,
  NoMatchingPoolMember,
  deserializeInvite,
  deviceSignatureSeed,
  serializeKeyPackage,
  type Conversation,
  type DeviceKeys,
} from '@argus/crypto';
import { signWelcomeConsume, signWelcomeFetch } from '@argus/crypto/device-proof';

import { consumeWelcome, fetchWelcomeMaterial, listWelcomes } from './api';

let enginePromise: Promise<MlsEngine> | null = null;
function getEngine(): Promise<MlsEngine> {
  enginePromise ??= MlsEngine.create();
  return enginePromise;
}

/** base64url, no padding — the wire form the welcome endpoints require for proofs (`^[A-Za-z0-9_-]+$`). */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A conversation joined from a delivered Welcome — its in-memory MLS group is retained for Slice 5. */
export interface JoinedConversation {
  conversationId: string;
  conversation: Conversation;
}

export interface JoinDeps {
  device: DeviceKeys;
  pool: DeviceKeys[];
  /** This device's server id — for the list/fetch/consume calls and the proofs. */
  deviceId: string;
  /** Remove the consumed one-time member from the sealed + in-memory pool (forward secrecy). */
  prunePoolMember: (publicKeyPackageB64: string) => Promise<void>;
  /** Surface a newly joined conversation to the UI. */
  onJoined: (joined: JoinedConversation) => void;
}

/**
 * Join every pending Welcome for this device. Per Welcome the order is join → consume → surface → prune:
 * consume runs only after a successful join (a failed join — e.g. a stranded `NoMatchingPoolMember` — skips
 * it for an idempotent retry); the conversation is surfaced only after a successful consume; the FS prune
 * runs LAST and best-effort, so a prune failure is logged loudly but never hides an already-joined,
 * already-consumed conversation (the lingering member stays unjoinable — its Welcome is gone — until the
 * server-side revoke (#20) + reconciliation). Per-Welcome failures are isolated so the drain continues.
 */
export async function joinPendingConversations(deps: JoinDeps): Promise<void> {
  const { device, pool, deviceId, prunePoolMember, onJoined } = deps;
  const engine = await getEngine();
  const signKey = deviceSignatureSeed(device); // ts-mls' 48-byte PKCS8 key → the bare 32-byte Ed25519 seed

  const pending = await listWelcomes(deviceId);
  for (const w of pending) {
    let member: DeviceKeys;
    try {
      const fetchProof = toBase64Url(signWelcomeFetch(signKey, deviceId, w.id));
      const material = await fetchWelcomeMaterial(w.id, deviceId, fetchProof);
      const joined = await engine.joinConversationFromPool(pool, deserializeInvite(material));
      member = joined.member;
      const consumeProof = toBase64Url(signWelcomeConsume(signKey, deviceId, w.id));
      await consumeWelcome(w.id, deviceId, consumeProof);
      onJoined({ conversationId: w.conversationId, conversation: joined.conversation });
    } catch (err) {
      // A stranded Welcome (its sealed-to private was discarded) matches no member — expected, skip quietly.
      // Anything else is unexpected: warn (non-secret — id + message only, never key bytes) and continue.
      if (!(err instanceof NoMatchingPoolMember)) {
        // eslint-disable-next-line no-console
        console.warn(`join: skipped welcome ${w.id}`, err instanceof Error ? err.message : err);
      }
      continue;
    }
    try {
      await prunePoolMember(serializeKeyPackage(member.publicPackage));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `join: pool prune failed for welcome ${w.id} (member lingers; see task #20)`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
