// Shared return-type interfaces for the messaging collaborators and the MessagingService façade.
// Extracted verbatim from messaging.service.ts during the Track-1 structural split (zero behavior
// change). The façade re-exports these, so existing imports from './messaging.service.js'
// (realtime-bus.ts → FetchedMessage, messaging.controller.ts → FetchedCommit) keep resolving.

export interface CreatedConversation {
  conversationId: string;
}

/** A pending MLS Welcome's METADATA, listed on connect. The opaque blobs are fetched SEPARATELY via a
 * device proof-of-possession (see WelcomeMaterial / getWelcomeMaterial), so listing leaks no join
 * material — a sibling session that spoofs a deviceId sees only ids, never another device's sealed blobs. */
export interface PendingWelcome {
  id: string;
  conversationId: string;
  /** The verified member who delivered it (set server-side) — the client names the conversation with it. */
  senderUserId: string;
  createdAt: string;
}

/** The opaque join material for one welcome — CIPHERTEXT ONLY (HPKE-sealed to the recipient device). */
export interface WelcomeMaterial {
  welcome: string;
  ratchetTree: string;
}

export interface SentMessage {
  messageId: string;
  createdAt: string;
  /** true when an idempotent retry matched an existing (sender, clientMessageId) — nothing new stored. */
  deduplicated: boolean;
}

export interface CommitResult {
  id: string;
  epoch: number;
  deduplicated: boolean;
}

/** One fetched commit — opaque mls_private_message base64 + routing metadata. Server never decrypts. */
export interface FetchedCommit {
  id: string;
  clientCommitId: string;
  epoch: number;
  senderUserId: string | null;
  commit: string;
  createdAt: string;
}

/** One fetched message — CIPHERTEXT ONLY plus routing metadata; the server never decrypts `ciphertext`. */
export interface FetchedMessage {
  id: string;
  /** null when the sender has exercised their GDPR right to erasure (account deleted). */
  senderUserId: string | null;
  clientMessageId: string;
  ciphertext: string;
  alg: string;
  epoch: number;
  attachmentObjectKey: string | null;
  createdAt: string;
  /**
   * Opaque keyset cursor for this message — echo as `after` to resume strictly after it. Prune-safe (it
   * carries `(created_at, id)`, so it survives this row's deletion). Populated by `listMessages`; absent on
   * the live WS push (single, not paginated). Optional so the WS frame and `SyncedMessage` need not set it.
   */
  cursor?: string;
}

export interface MessagePage {
  messages: FetchedMessage[];
  /**
   * LEGACY page cursor: the last message id, to pass as `after` for the next page (null when not a full
   * page). Kept for cached PWA bundles. New clients page off each message's prune-safe `cursor` instead.
   */
  nextCursor: string | null;
}

/** A message from the cross-conversation catch-up sync — carries its `conversationId` (the stream is
 * interleaved across all the caller's conversations, so each item must say which one it belongs to). */
export interface SyncedMessage extends FetchedMessage {
  conversationId: string;
}

export interface SyncPage {
  messages: SyncedMessage[];
  nextCursor: string | null;
}

/** A member's delivery/read high-water-marks in a conversation (metadata; checkpoint 31). */
export interface ConversationReceipt {
  userId: string;
  deliveredThroughMessageId: string | null;
  deliveredAt: string | null;
  readThroughMessageId: string | null;
  readAt: string | null;
}
