// Resolve a live conversation's peer to a real directory identity (#44b handle) — replacing the neutral
// "New contact" placeholder that joins/rehydrates start with. Naming is BEST-EFFORT and local: a failed
// directory lookup just leaves the placeholder (it self-heals on the next trigger). The peer's user id is
// always server-verified upstream (a welcome's senderUserId or a fetched message's senderUserId) — never
// client-supplied text.

import { listUsers, type UserSummary } from '../../lib/api';
import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
  type BrowserStorage,
} from '../../lib/persistence';
import { contactDisplayName } from './user-label';
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

// One directory fetch per session, shared across naming triggers; refreshed once on a miss (a peer who
// provisioned AFTER the cache filled — e.g. their very first login created the conversation).
let directoryCache: Promise<UserSummary[]> | null = null;

async function directory(refresh = false): Promise<UserSummary[]> {
  if (refresh || !directoryCache) {
    directoryCache = listUsers(100).catch((err: unknown) => {
      directoryCache = null; // don't cache a failure
      throw err;
    });
  }
  return directoryCache;
}

/** Test seam: drop the session directory cache. */
export function resetPeerDirectoryCache(): void {
  directoryCache = null;
}

/**
 * Resolve a peer user id to a UI identity via the tenant directory. Returns null when unknown (not in this
 * tenant, not yet provisioned, or the lookup failed) — callers keep the placeholder.
 */
export async function resolvePeerUser(userId: string): Promise<User | null> {
  try {
    let users = await directory();
    let found = users.find((u) => u.id === userId);
    if (!found) {
      users = await directory(true);
      found = users.find((u) => u.id === userId);
    }
    if (!found) return null;
    const name = contactDisplayName(found);
    // No isOnline: presence is UNKNOWN for live peers (there is no presence system) — never claim Offline.
    return { id: found.id, name, avatar: dicebearAvatar(found.id) };
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
          ? { ...participant, id: peer.id, name: peer.name, avatar: peer.avatar }
          : participant,
      ),
    };
  });
}
