// Live 1:1 messaging (Slice 5 PR-5B). The send + fetch half of the loop, on top of 5A's sealed group-state
// persistence. Everything here is crypto-blind to the server: only opaque base64 ciphertext + non-secret
// metadata (clientMessageId, alg, epoch) crosses the wire; plaintext and keys never leave the device.
//
// Ordering is the security-critical part. On SEND we encrypt → PERSIST → POST, all under the conversation's
// single-writer lock: the advanced ratchet is sealed durably BEFORE the message leaves the device, so a
// crash can never deliver a message whose state wasn't saved (which on reload would re-encrypt and REUSE an
// AEAD nonce). On RECEIVE we decrypt fetched ciphertext in order and persist the advanced state once.

import type { Conversation, DeviceKeys } from '@argus/crypto';

import { fetchMessages, sendMessage } from './api';
import { fromBase64, toBase64 } from './base64';
import type { DeviceKeystore } from './keystore';
import { conversationLock, withLock } from './locks';

// Non-secret AEAD/version tag stored alongside the ciphertext (server metadata only; it stays crypto-blind).
const WIRE_ALG = 'MLS_1.0';
const FETCH_PAGE = 100; // server max page
const MAX_BACKFILL_PAGES = 50; // safety cap on the page loop

/** What every ratchet-advancing op needs to seal the new state at rest (identity + signature-key bound). */
export interface MessagingDeps {
  keystore: DeviceKeystore;
  device: DeviceKeys;
  /** The session passphrase — seals the advanced group state. In memory only; never logged or transmitted. */
  passphrase: string;
}

/** The server's ack for a sent message, plus the clientMessageId we minted (for local correlation). */
export interface SentLiveMessage {
  serverId: string;
  clientMessageId: string;
  createdAt: string;
  deduplicated: boolean;
}

/**
 * Encrypt `plaintext` → persist the advanced state → POST the ciphertext, all under the conversation's
 * single-writer lock so concurrent ops can't interleave. The persist runs BEFORE the POST: a failed persist
 * (e.g. `GroupStateConflict` — another tab advanced the durable state) throws and aborts the send, so we
 * never transmit a message whose ratchet state wasn't saved. A failed POST leaves the (already persisted)
 * generation spent; the caller retries by re-sending (a fresh `clientMessageId` + generation). The server is
 * idempotent on `clientMessageId`.
 */
export async function sendLiveMessage(
  deps: MessagingDeps,
  conversationId: string,
  conversation: Conversation,
  plaintext: string,
): Promise<SentLiveMessage> {
  return withLock(conversationLock(conversationId), async () => {
    const wire = await conversation.encrypt(plaintext);
    // Persist the advanced ratchet BEFORE the ciphertext leaves the device (rollback/nonce-reuse guard).
    await deps.keystore.saveConversationState(
      deps.device,
      conversationId,
      conversation,
      deps.passphrase,
    );
    const clientMessageId = crypto.randomUUID();
    const ack = await sendMessage(conversationId, {
      clientMessageId,
      ciphertext: toBase64(wire),
      alg: WIRE_ALG,
      epoch: conversation.epoch,
    });
    return {
      serverId: ack.messageId,
      clientMessageId,
      createdAt: ack.createdAt,
      deduplicated: ack.deduplicated,
    };
  });
}

/** A decrypted incoming message — plaintext stays in memory only (never persisted; never sent back). */
export interface DecryptedMessage {
  serverId: string;
  senderUserId: string;
  clientMessageId: string;
  plaintext: string;
  createdAt: string;
}

/** Decrypted peer messages from a backfill, plus the high-water cursor to resume from next time. */
export interface BackfillResult {
  messages: DecryptedMessage[];
  /** The last server message id observed (pass as `after` next time to fetch only newer rows). */
  cursor: string | undefined;
}

/**
 * Back-fill a conversation's history under the single-writer lock: page oldest-first from `after`, decrypt
 * each PEER message in order, and persist the advanced state once at the end. The cursor advances past EVERY
 * fetched row (self/undecryptable included) so the next call fetches strictly newer messages.
 *
 * Own (self-authored) messages are skipped: MLS doesn't let a sender re-derive its own application-message
 * plaintext from the ratchet (the sending secret is consumed on encrypt). They're shown via local echo at
 * send time; cross-device own-history needs a local plaintext log (a documented v1 residual). An
 * undecryptable peer message (an already-consumed generation on a re-open, or a non-application frame) is
 * skipped, never failing the whole batch — id/metadata only in any log.
 */
export async function backfillConversation(
  deps: MessagingDeps,
  conversationId: string,
  conversation: Conversation,
  selfUserId: string,
  after?: string,
): Promise<BackfillResult> {
  return withLock(conversationLock(conversationId), async () => {
    const messages: DecryptedMessage[] = [];
    let cursor = after;
    let advanced = false;

    for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
      const res = await fetchMessages(conversationId, { after: cursor, limit: FETCH_PAGE });
      for (const m of res.messages) {
        cursor = m.id; // high-water mark — advance past everything, even what we skip
        if (m.senderUserId === selfUserId) continue; // can't decrypt our own; shown via local echo
        try {
          const plaintext = await conversation.decrypt(fromBase64(m.ciphertext));
          advanced = true;
          messages.push({
            serverId: m.id,
            senderUserId: m.senderUserId,
            clientMessageId: m.clientMessageId,
            plaintext,
            createdAt: m.createdAt,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            'backfill: skipped undecryptable message',
            m.id,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (!res.nextCursor || res.messages.length === 0) break;
      cursor = res.nextCursor;
    }

    if (advanced) {
      await deps.keystore.saveConversationState(
        deps.device,
        conversationId,
        conversation,
        deps.passphrase,
      );
    }
    return { messages, cursor };
  });
}
