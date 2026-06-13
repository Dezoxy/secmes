// Live 1:1 messaging (Slice 5 PR-5B). The send + fetch half of the loop, on top of 5A's sealed group-state
// persistence. Everything here is crypto-blind to the server: only opaque base64 ciphertext + non-secret
// metadata (clientMessageId, alg, epoch) crosses the wire; plaintext and keys never leave the device.
//
// Ordering is the security-critical part. On SEND we encrypt → PERSIST → POST, all under the conversation's
// single-writer lock: the advanced ratchet is sealed durably BEFORE the message leaves the device, so a
// crash can never deliver a message whose state wasn't saved (which on reload would re-encrypt and REUSE an
// AEAD nonce). On RECEIVE we decrypt fetched ciphertext in order and persist the advanced state once.

import type { Conversation, DeviceKeys } from '@argus/crypto';

import { fetchMessages, listCommits, sendMessage, type FetchedMessage } from './api';
import { fromBase64, toBase64 } from './base64';
import type { DeviceKeystore } from './keystore';
import { conversationLock, withLock } from './locks';
import {
  decodeEnvelope,
  encodeEnvelope,
  type AttachmentRef,
  type MessageEnvelope,
} from './message-envelope';

// Non-secret AEAD/version tag stored alongside the ciphertext (server metadata only; it stays crypto-blind).
const WIRE_ALG = 'MLS_1.0';
const FETCH_PAGE = 100; // server max page
const MAX_BACKFILL_PAGES = 50; // safety cap on the page loop

/** What every ratchet-advancing op needs to seal the new state at rest (identity + signature-key bound). */
export interface MessagingDeps {
  keystore: DeviceKeystore;
  device: DeviceKeys;
  /** The session passphrase — reseals the KeyPackage pool on join-time prunes. In memory only. */
  passphrase: string;
  /**
   * The per-unlock session key — seals the advanced group state on every send/receive (cheap AES-GCM; a
   * per-message Argon2id pass here was the live-loop's seconds-long delivery latency). Memory only.
   */
  sessionKey: CryptoKey;
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
  text: string,
  attachments: AttachmentRef[] = [],
  kind: MessageEnvelope['kind'] = 'app',
): Promise<SentLiveMessage> {
  // ALWAYS wrap in the versioned envelope — including text-only — so a user message that itself looks like
  // envelope JSON (e.g. `{"v":1,"text":"x","attachments":[]}`) is unambiguous on the wire: it becomes the
  // `text` field, never re-parsed as an envelope. `decodeEnvelope` still reads pre-A3 bare-string messages as
  // plain text (back-compat for already-sent history).
  const plaintext = encodeEnvelope({ kind, text, attachments });
  return withLock(conversationLock(conversationId), async () => {
    const wire = await conversation.encrypt(plaintext);
    // Persist the advanced ratchet BEFORE the ciphertext leaves the device (rollback/nonce-reuse guard).
    await deps.keystore.saveConversationState(
      deps.device,
      conversationId,
      conversation,
      deps.sessionKey,
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
  /** null when the sender has exercised their GDPR right to erasure (account deleted). */
  senderUserId: string | null;
  clientMessageId: string;
  /** The decoded message text — an old bare-string message decodes to itself. */
  text: string;
  /** Attachment refs carried E2E in the envelope (empty for text-only / pre-A3 messages). */
  attachments: AttachmentRef[];
  createdAt: string;
  /**
   * 'group-meta' for in-stream group-name updates (the text field carries the name); absent for
   * regular chat messages. Callers filter this out of the transcript but use the text to update
   * the conversation's display name.
   */
  kind?: 'group-meta';
}

/** Decrypted peer messages from a backfill, plus the high-water cursor to resume from next time. */
export interface BackfillResult {
  messages: DecryptedMessage[];
  /** The last server message id observed (pass as `after` next time to fetch only newer rows). */
  cursor: string | undefined;
  /**
   * Set to the epoch of the first un-decryptable message when the backfill stopped early because a
   * future-epoch message was encountered. The caller MUST drain commits to exactly this epoch (not
   * beyond) and then call backfillConversation again from the same cursor. Draining past this epoch
   * would advance the MLS ratchet state and make messages at this epoch permanently undecryptable.
   */
  nextEpoch: number | undefined;
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

    let nextEpoch: number | undefined; // set to the gap epoch when we stop early
    for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
      const res = await fetchMessages(conversationId, { after: cursor, limit: FETCH_PAGE });
      for (const m of res.messages) {
        // Stop WITHOUT advancing cursor if the message is at a future epoch. The caller MUST drain
        // commits to exactly this epoch (not beyond) and then call backfillConversation again —
        // draining further advances the ratchet past this epoch and makes these messages permanently
        // undecryptable (MLS forward secrecy).
        if (m.epoch > conversation.epoch) {
          nextEpoch = m.epoch;
          break;
        }
        cursor = m.id; // high-water mark — advance past everything at the current epoch
        if (m.senderUserId === selfUserId) continue; // can't decrypt our own; shown via local echo
        try {
          const plaintext = await conversation.decrypt(fromBase64(m.ciphertext));
          advanced = true;
          const env = decodeEnvelope(plaintext);
          messages.push({
            serverId: m.id,
            senderUserId: m.senderUserId,
            clientMessageId: m.clientMessageId,
            kind: env.kind === 'group-meta' ? 'group-meta' : undefined,
            text: env.text,
            attachments: env.attachments,
            createdAt: m.createdAt,
          });
        } catch (err) {
          // Truly undecryptable (e.g. pre-join message, already-consumed ratchet generation) —
          // advance past it so the cursor doesn't stall on the same message forever.
          // eslint-disable-next-line no-console
          console.warn(
            'backfill: skipped undecryptable message',
            m.id,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (nextEpoch !== undefined || !res.nextCursor || res.messages.length === 0) break;
      cursor = res.nextCursor;
    }

    if (advanced) {
      await deps.keystore.saveConversationState(
        deps.device,
        conversationId,
        conversation,
        deps.sessionKey,
      );
    }
    return { messages, cursor, nextEpoch };
  });
}

/**
 * Decrypt + persist ONE pushed message (the WebSocket path, 5C), under the conversation's single-writer
 * lock. Returns the decrypted message, or `null` if it's our own (already echoed locally), undecryptable
 * (an already-consumed generation — e.g. it also arrived via a catch-up fetch — or a non-application frame),
 * or carries no ciphertext. The caller dedups by `serverId` across push + fetch. Mirrors a single step of
 * `backfillConversation`, but persists immediately since pushes arrive one at a time.
 */
export async function receiveLiveMessage(
  deps: MessagingDeps,
  conversationId: string,
  conversation: Conversation,
  message: FetchedMessage,
  selfUserId: string,
): Promise<DecryptedMessage | null> {
  if (message.senderUserId === selfUserId) return null; // our own send — shown via local echo
  return withLock(conversationLock(conversationId), async () => {
    let plaintext: string;
    try {
      plaintext = await conversation.decrypt(fromBase64(message.ciphertext));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        'receive: skipped undecryptable message',
        message.id,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    await deps.keystore.saveConversationState(
      deps.device,
      conversationId,
      conversation,
      deps.sessionKey,
    );
    const env = decodeEnvelope(plaintext);
    return {
      serverId: message.id,
      senderUserId: message.senderUserId,
      clientMessageId: message.clientMessageId,
      kind: env.kind === 'group-meta' ? 'group-meta' : undefined,
      text: env.text,
      attachments: env.attachments,
      createdAt: message.createdAt,
    };
  });
}

// --- MLS commit drain state machine (B1 group chat) -------------------------------------------------
// On a `commit` WS event or reconnect, the client fetches + applies all unapplied commits in epoch order
// under the conversation's single-writer lock (same lock as sends/receives). Each commit is processed
// via `conversation.processCommit`, which advances the ratchet and persists the new state immediately
// via the keystore persister (built outside the conversation's op queue to avoid re-entering it).

/**
 * Fetch and apply commits after `afterEpoch` under the conversation lock, in epoch-ascending order.
 * Stops at the first unprocessable commit (subsequent epochs are unreachable without it).
 *
 * `maxEpoch` — when set, stops BEFORE applying any commit whose epoch exceeds this value. Use this
 * to advance the MLS ratchet to exactly the epoch needed to decrypt the next queued message — never
 * beyond it — so intermediate messages remain decryptable (MLS forward secrecy removes those keys
 * once the epoch is surpassed).
 */
export async function drainCommits(
  deps: MessagingDeps,
  conversationId: string,
  conversation: Conversation,
  afterEpoch: number,
  maxEpoch?: number,
): Promise<void> {
  return withLock(conversationLock(conversationId), async () => {
    const persister = deps.keystore.makeConversationPersister(
      deps.device,
      conversationId,
      deps.sessionKey,
    );
    const LIMIT = 50;
    let cursor = afterEpoch;
    for (;;) {
      const commits = await listCommits(conversationId, { afterEpoch: cursor, limit: LIMIT });
      for (const c of commits) {
        // Stop BEFORE the commit that would advance the group past maxEpoch. A commit stored with
        // epoch N takes the group from N → N+1, so to decrypt a message at epoch maxEpoch the group
        // must be at maxEpoch — meaning only commits with epoch < maxEpoch should be applied.
        if (maxEpoch !== undefined && c.epoch >= maxEpoch) return;
        try {
          await conversation.processCommit(fromBase64(c.commit), persister);
          cursor = c.epoch; // advance past this commit so the next page starts here
        } catch (err) {
          // Subsequent epochs can't be processed without this one — bail out entirely.
          // eslint-disable-next-line no-console
          console.warn(
            'drainCommits: stopped at unprocessable commit',
            c.id,
            'epoch',
            c.epoch,
            err instanceof Error ? err.message : err,
          );
          return;
        }
      }
      if (commits.length < LIMIT) break; // last page — no more commits to fetch
    }
  });
}

/**
 * Handle a `commit` WS event: if the event's epoch is ahead of the local epoch, drain from
 * the current epoch. If already past (stale event), ignore. Runs under the conversation lock.
 *
 * `maxEpoch` — passed through to `drainCommits`; callers on the message path should set this to
 * the message's epoch so the ratchet stops exactly there, keeping intermediate messages decryptable.
 */
export async function processCommitEvent(
  deps: MessagingDeps,
  conversationId: string,
  conversation: Conversation,
  event: { epoch: number },
  maxEpoch?: number,
): Promise<void> {
  const convEpoch = conversation.epoch;
  if (event.epoch < convEpoch) return; // stale — already at a later epoch
  // afterEpoch = convEpoch - 1 → returns commits with epoch > (convEpoch-1), i.e. epoch >= convEpoch.
  // No floor at 0: a group at epoch 0 passes -1 so the server returns epoch-0 commits too.
  const afterEpoch = convEpoch - 1;
  await drainCommits(deps, conversationId, conversation, afterEpoch, maxEpoch);
}
