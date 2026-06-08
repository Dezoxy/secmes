import { describe, expect, it } from 'vitest';
import { generatedAvatar } from '../chat/seed';
import { ARGUS_STORAGE_VERSION, type BrowserStorage } from '../../lib/persistence';
import {
  LEGACY_ARGUS_PROFILE_STORAGE_KEY,
  loadArgusProfile,
  profileStorageKey,
  saveArgusProfile,
} from './argus-profile';

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

class ReadBlockedStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }
}

describe('Argus pseudonymous profile boundary', () => {
  it('does not expose the authenticated subject or email-shaped legacy values as app identity', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LEGACY_ARGUS_PROFILE_STORAGE_KEY,
      JSON.stringify({
        id: 'zitadel-subject-123',
        username: 'alice@example.test',
        avatar: generatedAvatar('alice@example.test'),
      }),
    );

    const profile = loadArgusProfile({
      subjectId: 'zitadel-subject-123',
      storage,
      randomId: () => '00000000-0000-4000-8000-000000000001',
    });

    expect(profile.id).toBe('argus-00000000-0000-4000-8000-000000000001');
    expect(profile.id).not.toBe('zitadel-subject-123');
    expect(profile.username).toMatch(/^anon-/);
    expect(profile.username).not.toContain('@');
    expect(storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY)).toBeNull();
  });

  it('loads only records scoped to the active authenticated subject', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      profileStorageKey('subject-a'),
      JSON.stringify({
        version: ARGUS_STORAGE_VERSION,
        data: {
          subjectId: 'subject-a',
          profile: {
            id: 'argus-subject-a',
            username: 'operator-a',
            avatar: generatedAvatar('operator-a'),
          },
        },
      }),
    );
    storage.setItem(
      profileStorageKey('subject-b'),
      JSON.stringify({
        version: ARGUS_STORAGE_VERSION,
        data: {
          subjectId: 'subject-a',
          profile: {
            id: 'argus-wrong-subject',
            username: 'wrong-profile',
            avatar: generatedAvatar('wrong-profile'),
          },
        },
      }),
    );

    expect(
      loadArgusProfile({
        subjectId: 'subject-a',
        storage,
        randomId: () => 'unused',
      }).username,
    ).toBe('operator-a');

    expect(
      loadArgusProfile({
        subjectId: 'subject-b',
        storage,
        randomId: () => '00000000-0000-4000-8000-000000000002',
      }).username,
    ).not.toBe('wrong-profile');
  });

  it('persists a newly generated profile under the authenticated subject scope', () => {
    const storage = new MemoryStorage();

    const profile = loadArgusProfile({
      subjectId: 'subject-a',
      storage,
      randomId: () => '00000000-0000-4000-8000-000000000003',
    });

    expect(JSON.parse(storage.getItem(profileStorageKey('subject-a')) ?? '{}')).toMatchObject({
      version: ARGUS_STORAGE_VERSION,
      data: {
        subjectId: 'subject-a',
        profile: {
          id: profile.id,
          username: profile.username,
        },
      },
    });
  });

  it('falls back without crashing when browser storage reads are unavailable', () => {
    const storage = new ReadBlockedStorage();

    const profile = loadArgusProfile({
      subjectId: 'subject-a',
      storage,
      randomId: () => '00000000-0000-4000-8000-000000000005',
    });

    expect(profile.id).toBe('argus-00000000-0000-4000-8000-000000000005');
    expect(profile.username).toMatch(/^anon-/);
    expect(storage.items.size).toBe(0);
  });

  it('saves profile records under the authenticated subject scope only', () => {
    const storage = new MemoryStorage();
    const saved = saveArgusProfile({
      subjectId: 'subject-a',
      storage,
      profile: {
        id: 'argus-visible-id',
        username: 'shadow-operator',
        avatar: generatedAvatar('shadow-operator'),
      },
    });

    expect(saved).toBe(true);
    expect(storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(profileStorageKey('subject-a')) ?? '{}')).toMatchObject({
      version: ARGUS_STORAGE_VERSION,
      data: {
        subjectId: 'subject-a',
        profile: {
          id: 'argus-visible-id',
          username: 'shadow-operator',
        },
      },
    });
  });

  it('migrates safe legacy pseudonymous profile records into the authenticated subject scope', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LEGACY_ARGUS_PROFILE_STORAGE_KEY,
      JSON.stringify({
        id: 'argus-legacy-visible-id',
        username: 'legacy-operator',
        avatar: generatedAvatar('legacy-operator'),
      }),
    );

    const profile = loadArgusProfile({
      subjectId: 'subject-a',
      storage,
      randomId: () => 'unused',
    });

    expect(profile).toMatchObject({
      id: 'argus-legacy-visible-id',
      username: 'legacy-operator',
    });
    expect(storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(profileStorageKey('subject-a')) ?? '{}')).toMatchObject({
      version: ARGUS_STORAGE_VERSION,
      data: {
        subjectId: 'subject-a',
        profile: { id: 'argus-legacy-visible-id', username: 'legacy-operator' },
      },
    });
  });

  it('migrates unversioned scoped profile records saved by older clients', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      profileStorageKey('subject-a'),
      JSON.stringify({
        subjectId: 'subject-a',
        profile: {
          id: 'argus-old-scoped-id',
          username: 'old-operator',
          avatar: generatedAvatar('old-operator'),
        },
      }),
    );

    expect(
      loadArgusProfile({
        subjectId: 'subject-a',
        storage,
        randomId: () => 'unused',
      }),
    ).toMatchObject({ id: 'argus-old-scoped-id', username: 'old-operator' });
    expect(JSON.parse(storage.getItem(profileStorageKey('subject-a')) ?? '{}')).toMatchObject({
      version: ARGUS_STORAGE_VERSION,
      data: {
        subjectId: 'subject-a',
        profile: { id: 'argus-old-scoped-id', username: 'old-operator' },
      },
    });
  });

  it('wipes corrupted profile namespace state without touching unrelated storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(profileStorageKey('subject-a'), '{bad json');
    storage.setItem(profileStorageKey('subject-b'), 'stale');
    storage.setItem('argus:v1:settings:device', 'settings');
    storage.setItem('other-app', 'keep');

    const profile = loadArgusProfile({
      subjectId: 'subject-a',
      storage,
      randomId: () => '00000000-0000-4000-8000-000000000004',
    });

    expect(profile.id).toBe('argus-00000000-0000-4000-8000-000000000004');
    expect(storage.getItem(profileStorageKey('subject-b'))).toBeNull();
    expect(storage.getItem('argus:v1:settings:device')).toBe('settings');
    expect(storage.getItem('other-app')).toBe('keep');
  });

  it('refuses to persist the authenticated subject as the visible Argus ID', () => {
    const storage = new MemoryStorage();

    expect(
      saveArgusProfile({
        subjectId: 'subject-a',
        storage,
        profile: {
          id: 'subject-a',
          username: 'shadow-operator',
          avatar: generatedAvatar('shadow-operator'),
        },
      }),
    ).toBe(false);
    expect(storage.getItem(profileStorageKey('subject-a'))).toBeNull();
  });
});
