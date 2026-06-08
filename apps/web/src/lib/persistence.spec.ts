import { describe, expect, it } from 'vitest';
import {
  ARGUS_STORAGE_VERSION,
  LEGACY_ARGUS_PROFILE_STORAGE_KEY,
  migrateLegacyJsonRecord,
  readVersionedRecord,
  safeJsonParse,
  versionedStorageKey,
  wipeKnownArgusStorage,
  writeVersionedRecord,
  type BrowserStorage,
} from './persistence';

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

class QuotaStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException('full', 'QuotaExceededError');
  }
}

interface TestRecord {
  value: string;
}

const decodeTestRecord = (value: unknown): TestRecord | null =>
  isRecord(value) && typeof value.value === 'string' ? { value: value.value } : null;

describe('browser persistence helpers', () => {
  it('creates namespaced and scoped versioned storage keys', () => {
    expect(versionedStorageKey('profile', 'subject/a b')).toBe('argus:v1:profile:subject%2Fa%20b');
    expect(versionedStorageKey('Theme')).toBe('argus:v1:theme');
  });

  it('refuses key areas that must never be persisted in localStorage', () => {
    expect(() => versionedStorageKey('messages')).toThrow(
      'not allowed in persistent browser storage',
    );
    expect(() => versionedStorageKey('tokens')).toThrow(
      'not allowed in persistent browser storage',
    );
    expect(() => versionedStorageKey('presigned-urls')).toThrow(
      'not allowed in persistent browser storage',
    );
    expect(() => versionedStorageKey('decrypted-attachments')).toThrow(
      'not allowed in persistent browser storage',
    );
  });

  it('returns missing for absent records', () => {
    expect(
      readVersionedRecord({
        storage: new MemoryStorage(),
        key: versionedStorageKey('profile', 'subject'),
        decode: decodeTestRecord,
      }),
    ).toEqual({ status: 'missing' });
  });

  it('safe-parses JSON without throwing or exposing the raw payload', () => {
    expect(safeJsonParse('{bad json')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('returns invalid-json for corrupt records', () => {
    const storage = new MemoryStorage();
    const key = versionedStorageKey('profile', 'subject');
    storage.setItem(key, '{bad json');

    expect(readVersionedRecord({ storage, key, decode: decodeTestRecord })).toEqual({
      status: 'invalid-json',
    });
  });

  it('returns version-mismatch for unmigratable future records', () => {
    const storage = new MemoryStorage();
    const key = versionedStorageKey('profile', 'subject');
    storage.setItem(key, JSON.stringify({ version: ARGUS_STORAGE_VERSION + 1, data: {} }));

    expect(readVersionedRecord({ storage, key, decode: decodeTestRecord })).toEqual({
      status: 'version-mismatch',
    });
  });

  it('writes records with a version envelope and reports quota failures safely', () => {
    const key = versionedStorageKey('profile', 'subject');
    const storage = new MemoryStorage();

    expect(writeVersionedRecord({ storage, key, value: { value: 'ok' } })).toEqual({ ok: true });
    expect(JSON.parse(storage.getItem(key) ?? '{}')).toEqual({
      version: ARGUS_STORAGE_VERSION,
      data: { value: 'ok' },
    });

    expect(
      writeVersionedRecord({ storage: new QuotaStorage(), key, value: { value: 'nope' } }),
    ).toEqual({
      ok: false,
      reason: 'quota-exceeded',
    });
  });

  it('migrates safe legacy profile-shaped records into a versioned scoped key', () => {
    const storage = new MemoryStorage();
    const targetKey = versionedStorageKey('profile', 'subject-a');
    storage.setItem(
      LEGACY_ARGUS_PROFILE_STORAGE_KEY,
      JSON.stringify({
        subjectId: 'subject-a',
        profile: { id: 'argus-1', username: 'shadow-operator', avatar: 'avatar' },
      }),
    );

    const migrated = migrateLegacyJsonRecord({
      storage,
      legacyKey: LEGACY_ARGUS_PROFILE_STORAGE_KEY,
      targetKey,
      decode: (value) =>
        isRecord(value) &&
        value.subjectId === 'subject-a' &&
        isRecord(value.profile) &&
        typeof value.profile.id === 'string' &&
        typeof value.profile.username === 'string'
          ? {
              subjectId: value.subjectId,
              profile: {
                id: value.profile.id,
                username: value.profile.username,
                avatar: typeof value.profile.avatar === 'string' ? value.profile.avatar : '',
              },
            }
          : null,
    });

    expect(migrated.status).toBe('migrated');
    expect(storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(targetKey) ?? '{}')).toMatchObject({
      version: ARGUS_STORAGE_VERSION,
      data: {
        subjectId: 'subject-a',
        profile: { id: 'argus-1', username: 'shadow-operator' },
      },
    });
  });

  it('wipes only known scoped Argus keys, not unrelated browser storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('argus:v1:profile:subject-a', 'profile');
    storage.setItem('argus:v1:settings:device', 'settings');
    storage.setItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY, 'legacy-profile');
    storage.setItem('other-app', 'keep');

    expect(
      wipeKnownArgusStorage(storage, {
        prefixes: ['argus:v1:profile:'],
        legacyKeys: [LEGACY_ARGUS_PROFILE_STORAGE_KEY],
      }).sort(),
    ).toEqual(['argus.anonymousProfile.v1', 'argus:v1:profile:subject-a']);

    expect(storage.getItem('argus:v1:profile:subject-a')).toBeNull();
    expect(storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY)).toBeNull();
    expect(storage.getItem('argus:v1:settings:device')).toBe('settings');
    expect(storage.getItem('other-app')).toBe('keep');
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
