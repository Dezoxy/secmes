// Per-conversation mute state. Stored as a versioned JSON array of conversation IDs in localStorage.
// The mute action is triggered from the conversation context menu; this module is the single source
// of truth so both the menu and the Settings panel read from the same key.

import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
} from '../../lib/persistence';

const MUTED_CONVERSATIONS_KEY = versionedStorageKey('muted-conversations');
export const MUTES_CHANGED_EVENT = 'argus:mutes-changed';

function decodeMutedIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

export function readMutedConversationIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const stored = readVersionedRecord({
    storage: browserLocalStorage(),
    key: MUTED_CONVERSATIONS_KEY,
    decode: decodeMutedIds,
  });
  return new Set(stored.status === 'ok' ? stored.value : []);
}

function writeMutedConversationIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: MUTED_CONVERSATIONS_KEY,
    value: [...ids],
  });
  window.dispatchEvent(new CustomEvent(MUTES_CHANGED_EVENT, { detail: { ids: [...ids] } }));
}

export function muteConversation(id: string): void {
  const ids = readMutedConversationIds();
  ids.add(id);
  writeMutedConversationIds(ids);
}

export function unmuteConversation(id: string): void {
  const ids = readMutedConversationIds();
  ids.delete(id);
  writeMutedConversationIds(ids);
}

export function unmuteAll(): void {
  if (typeof window === 'undefined') return;
  writeMutedConversationIds(new Set());
  // Notify mounted components (ChatHeader) that all mutes were cleared so they
  // can refresh their local muted state without requiring a full re-render.
  window.dispatchEvent(new CustomEvent('argus:mutes-cleared'));
}

export function isConversationMuted(id: string): boolean {
  return readMutedConversationIds().has(id);
}

/**
 * Persist the muted-conversation count to Cache API so the service worker can
 * deliver pushes silently while any conversations are muted. Content-free push
 * payloads carry no conversation ID, so only coarse (any-muted → silent) is
 * possible without leaking metadata in the push payload.
 */
export async function syncMuteStateToCache(ids: Set<string>): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open('argus-settings');
    await cache.put(
      '/muted-conversations',
      new Response(JSON.stringify([...ids]), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  } catch {
    // Cache API unavailable; mute enforcement via SW degrades gracefully.
  }
}
