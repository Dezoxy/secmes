// Join on connect (Slice 4 recipient side; persistence closed in Slice 5 PR-5B). When the device is unlocked
// + provisioned, drain its pending Welcomes: list → fetch (with a proof) → join with the matching retained
// private → PERSIST the group state (5A) → surface → consume the Welcome → prune the spent private. The
// persist runs BEFORE the consume: consuming the Welcome (and pruning the one-time private) before a durable
// save was the Slice-4 data-loss risk (a refresh-after-join would lose the conversation forever), which is
// why it was deferred until 5A's sealed group-state store existed. Now a joined group survives a reload via
// persistence, so the Welcome + private can be released for forward secrecy. Stranded (permanently
// unjoinable) Welcomes are still cleared. Per-Welcome failures are isolated so the drain continues.

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
import type { DeviceKeystore } from './keystore';

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
  /** The verified member who added us (from the welcome row) — lets the UI name the conversation. */
  senderUserId: string;
}

export interface JoinDeps {
  device: DeviceKeys;
  pool: DeviceKeys[];
  /** This device's server id — for the list/fetch/consume(-clear) calls and the proofs. */
  deviceId: string;
  /** The sealed keystore — persists each joined group's state (5A) before its Welcome/private are released. */
  keystore: DeviceKeystore;
  /** The per-unlock PRF unlock key — seals each joined group's persisted state AND reseals the pruned pool
   * (cheap AES-GCM). Memory only. */
  sessionKey: CryptoKey;
  /** Surface a newly joined conversation to the UI. */
  onJoined: (joined: JoinedConversation) => void;
  /**
   * A one-time private has been spent on a DURABLE join (it opened a Welcome AND the group state was
   * persisted/already-owned). Lets a long-lived caller prune the SAME member from its session-level working
   * pool, so a LATER drain in the same session (e.g. a live `welcome` nudge) can't resurrect it —
   * `removePoolMember` updates only the sealed keystore, not the caller's in-memory pool. The member is a
   * reference from the passed `pool`, so the caller prunes by identity. Without this, the per-drain
   * `workingPool` guards reuse only WITHIN one call; this extends forward secrecy ACROSS calls. NOT called
   * when the persist throws (the Welcome stays pending for retry, so the private must remain available).
   * Best-effort/synchronous; throwing here is the caller's concern.
   */
  onSpent?: (member: DeviceKeys) => void;
}

/**
 * Join every pending Welcome for this device, draining ACROSS pages. `listWelcomes` returns one bounded
 * page (the server caps it at 100); we re-list until no FRESH (not-yet-tried) Welcome remains — a `seen`
 * set both terminates the loop and stops re-processing, and `MAX_DRAIN_PAGES` caps it. Per Welcome: fetch →
 * join with the matching retained private → PERSIST the group state → surface → consume the Welcome → prune
 * the spent private. The persist precedes the consume/prune (consuming before a durable save was the
 * Slice-4 data-loss risk). A stranded `NoMatchingPoolMember` (permanently unjoinable) is consumed to clear
 * it from the cursorless list, so a head of stranded Welcomes can't hide valid newer ones. A `workingPool`
 * shrinks as one-time members are spent — once a private has opened a Welcome it is NEVER reused within the
 * drain (forward secrecy), so a duplicate/replayed delivery sealed to the same package gets
 * `NoMatchingPoolMember` and is cleared. Per-Welcome failures are isolated so the drain continues.
 *
 * Now that joins consume their Welcome on success, the bounded cursorless list drains fully each connect
 * (no joined-but-unconsumed Welcomes holding slots), so a device in many conversations joins them all rather
 * than only the oldest page. Already-joined conversations come back via 5A persistence (rehydrate on unlock),
 * not a re-join. A persist failure (e.g. a cross-tab `GroupStateConflict`) leaves the Welcome pending for the
 * owning tab — never consumed without a durable save.
 */
export async function joinPendingConversations(deps: JoinDeps): Promise<void> {
  const { device, pool, deviceId, keystore, sessionKey, onJoined, onSpent } = deps;
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
        // it — it gets NoMatchingPoolMember and is cleared. (The SESSION-pool prune via `onSpent` is deferred
        // to AFTER the join is durable — see below — so a persist failure leaves the private available for
        // the retry that re-joins the still-pending Welcome.)
        const spent = workingPool.indexOf(joined.member);
        if (spent !== -1) workingPool.splice(spent, 1);
        // If this device ALREADY has durable state for this conversation, a prior join persisted it (and
        // advanced it) but its cleanup failed, so the Welcome is being replayed. Re-saving this Welcome's
        // FRESH post-join state would overwrite the advanced ratchet — a rollback the CAS can't catch
        // (same instance, matching version, after rehydrate set the base). So SKIP the save + surface (the
        // conversation is already recovered via rehydrate-on-unlock) and fall through to clear the redundant
        // Welcome + prune the private.
        if (!(await keystore.hasConversationState(device, w.conversationId))) {
          // Persist FIRST (5A) so a reload recovers it; only then surface. If the save throws (e.g. a
          // cross-tab GroupStateConflict — another tab joined + persisted this conversation), skip
          // consume/prune and leave the Welcome to the owner.
          await keystore.saveConversationState(
            device,
            w.conversationId,
            joined.conversation,
            sessionKey,
          );
          onJoined({
            conversationId: w.conversationId,
            conversation: joined.conversation,
            senderUserId: w.senderUserId,
          });
        }
        // The join is now DURABLE (freshly persisted just above, or already-owned on a replay): only NOW
        // prune the caller's SESSION pool. Deferring past the save is the safety property — if the save threw
        // it skipped to the outer catch (Welcome left PENDING), so `onSpent` never ran and a same-session
        // retry drain still has the private to re-join. Mirrors `removePoolMember` (the durable-pool prune).
        onSpent?.(joined.member);
        // Best-effort cleanup AFTER the durable save. Consume the Welcome (forward secrecy — the sealed join
        // material is no longer needed) then prune the spent one-time private from the sealed pool so it can
        // never reopen a (replayed) Welcome. Either failing is non-fatal: the persisted group already
        // recovers the conversation; a lingering Welcome/private is bounded + self-healing.
        try {
          const consumeProof = toBase64Url(signWelcomeConsume(signKey, deviceId, w.id));
          await consumeWelcome(w.id, deviceId, consumeProof);
        } catch (consumeErr) {
          // eslint-disable-next-line no-console
          console.warn(
            'join: persisted but could not consume welcome',
            w.id,
            consumeErr instanceof Error ? consumeErr.message : consumeErr,
          );
        }
        try {
          await keystore.removePoolMember(
            device,
            sessionKey,
            serializeKeyPackage(joined.member.publicPackage),
          );
        } catch (pruneErr) {
          // eslint-disable-next-line no-console
          console.warn(
            'join: persisted but could not prune pool member',
            w.id,
            pruneErr instanceof Error ? pruneErr.message : pruneErr,
          );
        }
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
