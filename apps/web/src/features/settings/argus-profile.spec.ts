import { describe, expect, it } from 'vitest';
import { generatedAvatar } from '../chat/seed';
import {
  LEGACY_ARGUS_PROFILE_STORAGE_KEY,
  loadArgusProfile,
  profileStorageKey,
  saveArgusProfile,
} from './argus-profile';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
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
  });

  it('loads only records scoped to the active authenticated subject', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      profileStorageKey('subject-a'),
      JSON.stringify({
        subjectId: 'subject-a',
        profile: {
          id: 'argus-subject-a',
          username: 'operator-a',
          avatar: generatedAvatar('operator-a'),
        },
      }),
    );
    storage.setItem(
      profileStorageKey('subject-b'),
      JSON.stringify({
        subjectId: 'subject-a',
        profile: {
          id: 'argus-wrong-subject',
          username: 'wrong-profile',
          avatar: generatedAvatar('wrong-profile'),
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
      subjectId: 'subject-a',
      profile: {
        id: profile.id,
        username: profile.username,
      },
    });
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
      subjectId: 'subject-a',
      profile: {
        id: 'argus-visible-id',
        username: 'shadow-operator',
      },
    });
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
