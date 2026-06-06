// Client-side view model for the chat UI.
//
// IMPORTANT: `body` and image bytes here are DECRYPTED plaintext that exists ONLY in browser memory.
// In the live app they are produced by MLS decryption (`@argus/crypto`) after fetching opaque ciphertext
// from the crypto-blind server — the server never sees any of this. The fetch→decrypt→(this shape) wiring
// lands with the Phase-3 client loop; for now a local seed drives the UI so the UX can be built + reviewed.

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read';

export interface Contact {
  id: string;
  name: string;
  online?: boolean;
}

export interface ImageAttachment {
  id: string;
  /** An in-memory object URL / data URI for the DECRYPTED image — never a server URL. */
  src: string;
  alt: string;
}

export interface ChatMessage {
  id: string;
  /** The sender's contact id, or `ME` for the local user. */
  senderId: string;
  /** Decrypted plaintext (client-only). */
  body: string;
  /** Epoch milliseconds. */
  sentAt: number;
  /** Delivery state shown on the user's own messages. */
  status: DeliveryStatus;
  images?: ImageAttachment[];
}

export type ConversationKind = 'direct' | 'group';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  /** Group title (decrypted, client-side). Direct chats use the other participant's name. */
  title?: string;
  participants: Contact[];
  messages: ChatMessage[];
  unread: number;
}

/** Sentinel id for the local user. */
export const ME = 'me';

export function otherParticipant(c: Conversation): Contact | undefined {
  return c.participants.find((p) => p.id !== ME);
}

export function conversationTitle(c: Conversation): string {
  if (c.kind === 'group') return c.title ?? 'Group';
  return otherParticipant(c)?.name ?? 'Unknown';
}

export function lastMessage(c: Conversation): ChatMessage | undefined {
  return c.messages[c.messages.length - 1];
}
