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
  /** This device's server id — for the list/fetch/consume calls and the proofs. */
  deviceId: string;
  /** Remove the consumed one-time member from the sealed + in-memory pool (forward secrecy). */
  prunePoolMember: (publicKeyPackageB64: string) => Promise<void>;
  /** Surface a newly joined conversation to the UI. */
  onJoined: (joined: JoinedConversation) => void;
}

/**
 * Join every pending Welcome for this device, draining ACROSS pages. `listWelcomes` returns one bounded
 * page (the server caps it at 100); consumed Welcomes drop off, so we re-list until no FRESH (not-yet-tried)
 * Welcome remains — a `seen` set both terminates the loop and stops re-processing already-skipped ones, and
 * `MAX_DRAIN_PAGES` caps it. Per Welcome: join → consume → surface → prune. consume runs only after a
 * successful join (a stranded `NoMatchingPoolMember` is skipped for an idempotent retry); the conversation
 * is surfaced only after a successful consume; the FS prune runs LAST and best-effort. A `workingPool`
 * shrinks as one-time members are spent — once a private has opened a Welcome it is NEVER reused within the
 * drain (forward secrecy), so a duplicate/replayed delivery sealed to the same package can't reuse it (it
 * gets `NoMatchingPoolMember` and is skipped). Per-Welcome failures are isolated so the drain continues.
 */
export async function joinPendingConversations(deps: JoinDeps): Promise<void> {
  const { device, pool, deviceId, prunePoolMember, onJoined } = deps;
  const engine = await getEngine();
  const signKey = deviceSignatureSeed(device); // ts-mls' 48-byte PKCS8 key → the bare 32-byte Ed25519 seed
  const workingPool = [...pool]; // shrinks as members are spent — never reuse a one-time private in a drain
  const seen = new Set<string>(); // welcome ids already attempted — terminates the re-list loop

  for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
    const pending = await listWelcomes(deviceId, WELCOME_PAGE);
    const fresh = pending.filter((w) => !seen.has(w.id));
    if (fresh.length === 0) break; // nothing new — consumed Welcomes are gone, the rest are already-tried skips

    for (const w of fresh) {
      seen.add(w.id);
      let member: DeviceKeys;
      try {
        const fetchProof = toBase64Url(signWelcomeFetch(signKey, deviceId, w.id));
        const material = await fetchWelcomeMaterial(w.id, deviceId, fetchProof);
        const joined = await engine.joinConversationFromPool(
          workingPool,
          deserializeInvite(material),
        );
        member = joined.member;
        // A one-time private, once it has opened a Welcome, must NEVER open another (forward secrecy). Drop
        // it from the working pool so a later Welcome in this drain sealed to the same package can't reuse
        // it — it gets NoMatchingPoolMember and is skipped.
        const spent = workingPool.indexOf(member);
        if (spent !== -1) workingPool.splice(spent, 1);
        const consumeProof = toBase64Url(signWelcomeConsume(signKey, deviceId, w.id));
        await consumeWelcome(w.id, deviceId, consumeProof);
        onJoined({ conversationId: w.conversationId, conversation: joined.conversation });
      } catch (err) {
        // A stranded Welcome (its sealed-to private was discarded) matches no member — expected, skip
        // quietly. Anything else: warn (non-secret — id + message only, never key bytes) and continue.
        if (!(err instanceof NoMatchingPoolMember)) {
          // Constant format string (the id is a separate arg) — never interpolate untrusted data into a
          // console format string (semgrep unsafe-formatstring).
          // eslint-disable-next-line no-console
          console.warn('join: skipped welcome', w.id, err instanceof Error ? err.message : err);
        }
        continue;
      }
      try {
        await prunePoolMember(serializeKeyPackage(member.publicPackage));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          'join: pool prune failed (member lingers; see task #20) for welcome',
          w.id,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
