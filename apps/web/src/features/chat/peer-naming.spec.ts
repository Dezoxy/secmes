import { describe, expect, it } from 'vitest';
import type { BrowserStorage } from '../../lib/persistence';
import { loadPersistedPeerMapping, persistPeerMapping } from './peer-naming';

class MemoryStorage implements BrowserStorage {
  readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('persistPeerMapping / loadPersistedPeerMapping', () => {
  it('round-trips a peer user id', () => {
    const storage = new MemoryStorage();
    persistPeerMapping('conv-abc', 'user-xyz', storage);
    expect(loadPersistedPeerMapping('conv-abc', storage)).toBe('user-xyz');
  });

  it('uses the argus:v1:peer-mapping:<conversationId> key', () => {
    const storage = new MemoryStorage();
    persistPeerMapping('conv-abc', 'user-xyz', storage);
    expect(storage.items.has('argus:v1:peer-mapping:conv-abc')).toBe(true);
  });

  it('returns null for a missing key', () => {
    const storage = new MemoryStorage();
    expect(loadPersistedPeerMapping('conv-missing', storage)).toBeNull();
  });

  it('returns null for a corrupt/non-versioned value', () => {
    const storage = new MemoryStorage();
    storage.setItem('argus:v1:peer-mapping:conv-corrupt', 'not-json{{{');
    expect(loadPersistedPeerMapping('conv-corrupt', storage)).toBeNull();
  });

  it('returns null when the record has no peerId field', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'argus:v1:peer-mapping:conv-bad',
      JSON.stringify({ version: 1, data: { other: 'field' } }),
    );
    expect(loadPersistedPeerMapping('conv-bad', storage)).toBeNull();
  });

  it('overwrites an existing mapping on re-persist', () => {
    const storage = new MemoryStorage();
    persistPeerMapping('conv-abc', 'user-first', storage);
    persistPeerMapping('conv-abc', 'user-second', storage);
    expect(loadPersistedPeerMapping('conv-abc', storage)).toBe('user-second');
  });

  it('isolates mappings per conversation id', () => {
    const storage = new MemoryStorage();
    persistPeerMapping('conv-1', 'user-a', storage);
    persistPeerMapping('conv-2', 'user-b', storage);
    expect(loadPersistedPeerMapping('conv-1', storage)).toBe('user-a');
    expect(loadPersistedPeerMapping('conv-2', storage)).toBe('user-b');
  });
});
