// Pure receipt logic for the live message loop (checkpoint 31). Kept out of the React components because
// the web test env is `node` (no jsdom) — components can't be unit-tested, so the real logic lives here.
//
// Two jobs:
//  - foldOwnMessageStatuses: turn a PEER's delivered/read high-water-marks into per-message tick states on
//    the SENDER's own messages (single ✓ → ✓✓ delivered → "read"). Driven by watermarks, never timers.
//  - nextReceiptToPost: decide which message id (if any) the RECEIVER should advance its watermark to,
//    with client-side dedup so we don't re-POST an unchanged watermark.

import type { Message, MessageStatus } from './seed';

/** A peer's high-water-marks in a conversation — server message ids (or null until the peer first acks). */
export interface PeerWatermarks {
  deliveredThroughMessageId: string | null;
  readThroughMessageId: string | null;
}

// Tick progression for OWN messages. `failed`/`sending` are send-lifecycle states the receipt fold must
// never overwrite; `sent`→`delivered`→`read` is the watermark-driven part.
const RANK: Record<MessageStatus, number> = {
  failed: -1,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};
const BY_RANK: MessageStatus[] = ['sending', 'sent', 'delivered', 'read'];

/**
 * Recompute OWN messages' delivery ticks from a peer's watermarks. Pure — returns a new array; only own
 * messages (senderId === ownSenderId) in a sent state change.
 *
 * Rules:
 *  - `failed` and `sending` are never touched (the watermark can't apply to an unsent / failed message).
 *  - Otherwise the displayed rank = max(current, watermark-implied) — so it NEVER downgrades a real send
 *    state; a peer's monotonic watermark only ever moves a tick forward.
 *  - Reciprocal privacy: when MY read receipts are off (`myReadReceiptsEnabled === false`) the result is
 *    capped at `delivered` — I don't render a peer's `read` while hiding my own. This cap is the one
 *    intentional display reduction (it's a privacy choice, not a watermark rollback).
 *  - A watermark whose message id isn't in `messages` yet (not loaded) contributes nothing — the tick
 *    advances once backfill brings that message in. Conservative, never wrong.
 */
export function foldOwnMessageStatuses(
  messages: Message[],
  ownSenderId: string,
  peer: PeerWatermarks,
  myReadReceiptsEnabled: boolean,
): Message[] {
  const indexById = new Map<string, number>();
  messages.forEach((m, i) => indexById.set(m.id, i));
  const deliveredIdx = peer.deliveredThroughMessageId
    ? (indexById.get(peer.deliveredThroughMessageId) ?? -1)
    : -1;
  const readIdx = peer.readThroughMessageId ? (indexById.get(peer.readThroughMessageId) ?? -1) : -1;

  return messages.map((m, i) => {
    if (m.senderId !== ownSenderId) return m; // incoming — no own-tick to fold
    if (m.status === 'failed' || m.status === 'sending') return m; // never overwrite send lifecycle

    let impliedRank = 0;
    if (deliveredIdx >= 0 && i <= deliveredIdx) impliedRank = RANK.delivered;
    if (myReadReceiptsEnabled && readIdx >= 0 && i <= readIdx) impliedRank = RANK.read;

    let nextRank = Math.max(RANK[m.status], impliedRank);
    if (!myReadReceiptsEnabled) nextRank = Math.min(nextRank, RANK.delivered); // reciprocal display cap

    const next = BY_RANK[nextRank] ?? m.status; // nextRank is always in [sent..read]; fallback satisfies TS
    return next === m.status ? m : { ...m, status: next };
  });
}

/**
 * The newest INCOMING message id the receiver should advance its watermark to, or null if there's nothing
 * new to acknowledge. Acking the latest message from the peer covers all earlier ones (high-water-mark).
 * Returns null when the newest incoming message was already posted (`lastPostedId`) — client-side dedup so
 * we don't spam POST /receipts (the server is monotonic, but this avoids the needless round-trips).
 */
export function nextReceiptToPost(
  messages: Message[],
  ownSenderId: string,
  lastPostedId: string | null,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.senderId !== ownSenderId) {
      return m.id === lastPostedId ? null : m.id;
    }
  }
  return null; // no incoming messages yet
}
