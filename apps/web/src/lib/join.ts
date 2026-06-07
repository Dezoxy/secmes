// Join on connect (Slice 4, recipient side). When the device is unlocked + provisioned, drain its pending
// Welcomes: list → fetch (with a proof) → join with the matching retained private → surface the group.
// We do NOT consume the Welcome or prune the private yet — the in-memory group state isn't persisted until
// Slice 5, so the still-pending Welcome (+ its retained private) is the ONLY durable way to recover a
// conversation after a reload. Consuming now would make a refresh-after-join lose the conversation
// permanently. Slice 5 persists group state, after which consume + prune become safe. Stranded (permanently
// unjoinable) Welcomes ARE cleared — they have no joinable state to lose. Per-Welcome failures are isolated.

import {
  MlsEngine,
  NoMatchingPoolMember,
  deserializeInvite,
  deviceSignatureSeed,
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

const WELCOME_PAGE = 100; // request the server's max list page; re-list to drain beyond it
const MAX_DRAIN_PAGES = 50; // safety cap on the re-list loop (≤ 200 packages/device ÷ 100 per page)

/** A conversation joined from a delivered Welcome — its in-memory MLS group is retained for Slice 5. */
export interface JoinedConversation {
  conversationId: string;
  conversation: Conversation;
}

export interface JoinDeps {
  device: DeviceKeys;
  pool: DeviceKeys[];
  /** This device's server id — for the list/fetch/consume(-clear) calls and the proofs. */
  deviceId: string;
  /** Surface a newly joined conversation to the UI. */
  onJoined: (joined: JoinedConversation) => void;
}

/**
 * Join every pending Welcome for this device, draining ACROSS pages. `listWelcomes` returns one bounded
 * page (the server caps it at 100); we re-list until no FRESH (not-yet-tried) Welcome remains — a `seen`
 * set both terminates the loop and stops re-processing, and `MAX_DRAIN_PAGES` caps it. Per Welcome: fetch →
 * join with the matching retained private → surface. We do NOT consume or prune a JOINED Welcome (no durable
 * group-state store until Slice 5 — the pending Welcome is the only way to recover the conversation on
 * reload). A stranded `NoMatchingPoolMember` (permanently unjoinable) IS consumed to clear it from the
 * cursorless list, so a head of stranded Welcomes can't hide valid newer ones. A `workingPool` shrinks as
 * one-time members are spent — once a private has opened a Welcome it is NEVER reused within the drain
 * (forward secrecy), so a duplicate/replayed delivery sealed to the same package gets `NoMatchingPoolMember`
 * and is cleared. Per-Welcome failures are isolated so the drain continues.
 *
 * NOTE the bounded, cursorless list means joined-but-unconsumed Welcomes hold their slots, so a device in
 * more than one page of conversations joins only the oldest page per connect until Slice 5's persistence
 * lets consumption (and thus drop-off) happen — strictly better than the permanent loss that consuming
 * before persistence would cause.
 */
export async function joinPendingConversations(deps: JoinDeps): Promise<void> {
  const { device, pool, deviceId, onJoined } = deps;
  const engine = await getEngine();
  const signKey = deviceSignatureSeed(device); // ts-mls' 48-byte PKCS8 key → the bare 32-byte Ed25519 seed
  const workingPool = [...pool]; // shrinks as members are spent — never reuse a one-time private in a drain
  const seen = new Set<string>(); // welcome ids already attempted — terminates the re-list loop

  for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
    const pending = await listWelcomes(deviceId, WELCOME_PAGE);
    const fresh = pending.filter((w) => !seen.has(w.id));
    if (fresh.length === 0) break; // nothing new — already-tried Welcomes (joined/skipped) hold the page

    for (const w of fresh) {
      seen.add(w.id);
      try {
        const fetchProof = toBase64Url(signWelcomeFetch(signKey, deviceId, w.id));
        const material = await fetchWelcomeMaterial(w.id, deviceId, fetchProof);
        const joined = await engine.joinConversationFromPool(
          workingPool,
          deserializeInvite(material),
        );
        // A one-time private, once it has opened a Welcome, must NEVER open another (forward secrecy). Drop
        // it from the working pool so a later Welcome in this drain sealed to the same package can't reuse
        // it — it gets NoMatchingPoolMember and is cleared.
        const spent = workingPool.indexOf(joined.member);
        if (spent !== -1) workingPool.splice(spent, 1);
        // Surface the joined group, but leave the Welcome PENDING (no consume/prune until Slice 5 persists
        // the group state) so a reload can re-join from it — consuming now would lose the conversation.
        onJoined({ conversationId: w.conversationId, conversation: joined.conversation });
      } catch (err) {
        if (err instanceof NoMatchingPoolMember) {
          // A stranded Welcome — sealed to a private this device discarded (reset/recovery) or to a
          // one-time package already spent earlier in this drain — is permanently unjoinable. CONSUME it to
          // drop it from the bounded, CURSORLESS list (otherwise a head of stranded Welcomes would hide
          // valid newer ones). Nothing recoverable is lost: the private is gone, so no one can ever open it.
          try {
            const clearProof = toBase64Url(signWelcomeConsume(signKey, deviceId, w.id));
            await consumeWelcome(w.id, deviceId, clearProof);
          } catch (clearErr) {
            // eslint-disable-next-line no-console
            console.warn(
              'join: could not clear stranded welcome',
              w.id,
              clearErr instanceof Error ? clearErr.message : clearErr,
            );
          }
        } else {
          // A transient/unexpected error (e.g. fetch failed) — leave the Welcome pending for a retry.
          // Constant format string (the id is a separate arg) — never interpolate untrusted data into a
          // console format string (semgrep unsafe-formatstring).
          // eslint-disable-next-line no-console
          console.warn('join: skipped welcome', w.id, err instanceof Error ? err.message : err);
        }
      }
    }
  }
}
