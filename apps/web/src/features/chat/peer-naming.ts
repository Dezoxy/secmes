// Resolve a live conversation's peer to a real identity — replacing the neutral "New contact"
// placeholder that joins/rehydrates start with. Naming is BEST-EFFORT and local: a failed lookup
// just leaves the placeholder (self-heals on the next trigger). The peer's user id is always
// server-verified upstream (a welcome's senderUserId or a fetched message's senderUserId) — never
// client-supplied text.

import { getConversationMembers, type ConversationMember } from '../../lib/api';
import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
  type BrowserStorage,
} from '../../lib/persistence';
import { dicebearAvatar } from '../../lib/dicebear';
import type { Conversation, User } from './seed';

/** The placeholder participant id a not-yet-named live conversation carries (see liveConversationShell). */
export function placeholderPeerId(conversationId: string): string {
  return `peer-${conversationId}`;
}

interface PeerMapping {
  peerId: string;
}

function decodePeerMapping(value: unknown): PeerMapping | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'peerId' in value &&
    typeof (value as Record<string, unknown>).peerId === 'string'
  ) {
    return value as PeerMapping;
  }
  return null;
}

/**
 * Persist the real peer user id for a direct conversation so rehydration can name the peer on reload
 * even when no messages have been exchanged yet (closes the dedup gap: issue #160).
 */
export function persistPeerMapping(
  conversationId: string,
  peerId: string,
  storage: BrowserStorage = browserLocalStorage(),
): void {
  writeVersionedRecord({
    storage,
    key: versionedStorageKey('peer-mapping', conversationId),
    value: { peerId },
  });
}

/**
 * Load a previously persisted peer user id for a conversation. Returns null when absent or unreadable.
 */
export function loadPersistedPeerMapping(
  conversationId: string,
  storage: BrowserStorage = browserLocalStorage(),
): string | null {
  const result = readVersionedRecord<PeerMapping>({
    storage,
    key: versionedStorageKey('peer-mapping', conversationId),
    decode: decodePeerMapping,
  });
  return result.status === 'ok' ? result.value.peerId : null;
}

// Per-conversation members cache: avoids re-fetching for every naming trigger in the same session.
const membersCache = new Map<string, Promise<ConversationMember[]>>();

async function conversationMembers(
  conversationId: string,
  refresh = false,
): Promise<ConversationMember[]> {
  if (refresh || !membersCache.has(conversationId)) {
    const p = getConversationMembers(conversationId).catch((err: unknown) => {
      membersCache.delete(conversationId);
      throw err;
    });
    membersCache.set(conversationId, p);
  }
  return membersCache.get(conversationId)!;
}

/** Test seam: drop the per-conversation members cache. */
export function resetPeerDirectoryCache(): void {
  membersCache.clear();
}

/**
 * Resolve a peer user id to a UI identity via the conversation member list. Returns null when
 * unknown (not a member, not yet provisioned, or the lookup failed) — callers keep the placeholder.
 */
export async function resolvePeerUser(
  userId: string,
  conversationId: string,
): Promise<User | null> {
  try {
    let members = await conversationMembers(conversationId);
    let found = members.find((m) => m.userId === userId);
    if (!found) {
      members = await conversationMembers(conversationId, true);
      found = members.find((m) => m.userId === userId);
    }
    if (!found) return null;
    const name = found.displayName?.trim() || 'Anonymous';
    return { id: found.userId, name, argusId: found.argusId, avatar: dicebearAvatar(found.userId) };
  } catch {
    return null;
  }
}

/**
 * Pure updater: swap `conversationId`'s placeholder peer for the resolved identity. No-ops when the
 * conversation is absent, isn't direct, or was already named (no placeholder participant left). Adopting
 * the REAL user id also fixes sender attribution (message senderIds are server user ids).
 */
export function withPeerNamed(
  conversations: Conversation[],
  conversationId: string,
  peer: User,
): Conversation[] {
  const placeholder = placeholderPeerId(conversationId);
  return conversations.map((conversation) => {
    if (conversation.id !== conversationId || conversation.type !== 'direct') return conversation;
    if (!conversation.participants.some((participant) => participant.id === placeholder)) {
      return conversation;
    }
    return {
      ...conversation,
      participants: conversation.participants.map((participant) =>
        participant.id === placeholder
          ? {
              ...participant,
              id: peer.id,
              name: peer.name,
              argusId: peer.argusId,
              avatar: peer.avatar,
            }
          : participant,
      ),
    };
  });
}
