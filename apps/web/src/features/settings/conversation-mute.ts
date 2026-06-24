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
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: MUTED_CONVERSATIONS_KEY,
    value: [],
  });
}

export function isConversationMuted(id: string): boolean {
  return readMutedConversationIds().has(id);
}
