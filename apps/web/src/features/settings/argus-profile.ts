import { generatedAvatar, safeAvatarSrc } from '../chat/seed';
import {
  browserLocalStorage,
  LEGACY_ARGUS_PROFILE_STORAGE_KEY,
  migrateLegacyJsonRecord,
  readLegacyJsonRecord,
  readVersionedRecord,
  versionedStorageKey,
  wipeKnownArgusStorage,
  writeVersionedRecord,
  type BrowserStorage,
} from '../../lib/persistence';
import type { AnonymousProfile } from './SettingsPanel';

export { LEGACY_ARGUS_PROFILE_STORAGE_KEY } from '../../lib/persistence';
export const ARGUS_PROFILE_STORAGE_PREFIX = 'argus:v1:profile:';

interface StoredArgusProfile {
  subjectId: string;
  profile: AnonymousProfile;
}

interface ProfileOptions {
  subjectId: string;
  storage?: BrowserStorage;
  randomId?: () => string;
}

interface SaveProfileOptions {
  subjectId: string;
  profile: AnonymousProfile;
  storage?: BrowserStorage;
}

type ProfileMigrationResult =
  | { status: 'migrated'; profile: AnonymousProfile }
  | { status: 'not-migrated'; shouldWipe: boolean }
  | { status: 'unavailable' };

export function profileStorageKey(subjectId: string): string {
  return versionedStorageKey('profile', subjectId);
}

function randomProfileId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('crypto.randomUUID is required to create an Argus profile id');
  }
  return globalThis.crypto.randomUUID();
}

function defaultAnonymousName(id: string): string {
  const suffix = id.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'local';
  return `anon-${suffix}`;
}

function createDefaultProfile(randomId = randomProfileId): AnonymousProfile {
  const id = `argus-${randomId()}`;
  const username = defaultAnonymousName(id);
  return {
    id,
    username,
    avatar: generatedAvatar(username),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function decodeScopedProfileRecord(value: unknown, subjectId: string): StoredArgusProfile | null {
  if (!isRecord(value) || value.subjectId !== subjectId || !isRecord(value.profile)) {
    return null;
  }

  const profile = value.profile;
  if (typeof profile.id !== 'string' || profile.id === subjectId) return null;

  const username =
    typeof profile.username === 'string' &&
    profile.username.trim() &&
    !isEmailLike(profile.username.trim())
      ? profile.username.trim()
      : defaultAnonymousName(profile.id);
  const avatar = typeof profile.avatar === 'string' ? profile.avatar : undefined;

  return {
    subjectId,
    profile: {
      id: profile.id,
      username,
      avatar: safeAvatarSrc(avatar, username),
    },
  };
}

function decodeLegacyProfileRecord(value: unknown, subjectId: string): StoredArgusProfile | null {
  if (!isRecord(value)) return null;

  if (isRecord(value.profile)) return decodeScopedProfileRecord(value, subjectId);

  if (typeof value.id !== 'string' || value.id === subjectId || !value.id.startsWith('argus-')) {
    return null;
  }

  const username =
    typeof value.username === 'string' &&
    value.username.trim() &&
    !isEmailLike(value.username.trim())
      ? value.username.trim()
      : defaultAnonymousName(value.id);
  const avatar = typeof value.avatar === 'string' ? value.avatar : undefined;

  return {
    subjectId,
    profile: {
      id: value.id,
      username,
      avatar: safeAvatarSrc(avatar, username),
    },
  };
}

function migrateCurrentKeyRecord(
  storage: BrowserStorage,
  key: string,
  subjectId: string,
): ProfileMigrationResult {
  const legacy = readLegacyJsonRecord({
    storage,
    key,
    decode: (value) => decodeScopedProfileRecord(value, subjectId),
  });
  if (legacy.status === 'unavailable') return { status: 'unavailable' };
  if (legacy.status !== 'ok') return { status: 'not-migrated', shouldWipe: true };

  writeVersionedRecord({ storage, key, value: legacy.value });
  return { status: 'migrated', profile: legacy.value.profile };
}

function migrateLegacyProfileRecord(
  storage: BrowserStorage,
  key: string,
  subjectId: string,
): ProfileMigrationResult {
  const migrated = migrateLegacyJsonRecord({
    storage,
    legacyKey: LEGACY_ARGUS_PROFILE_STORAGE_KEY,
    targetKey: key,
    decode: (value) => decodeLegacyProfileRecord(value, subjectId),
  });
  if (migrated.status === 'migrated')
    return { status: 'migrated', profile: migrated.value.profile };
  if (migrated.status === 'unavailable') return { status: 'unavailable' };
  return { status: 'not-migrated', shouldWipe: migrated.status !== 'missing' };
}

function wipeProfileNamespace(storage: BrowserStorage): void {
  wipeKnownArgusStorage(storage, {
    prefixes: [ARGUS_PROFILE_STORAGE_PREFIX],
    legacyKeys: [LEGACY_ARGUS_PROFILE_STORAGE_KEY],
  });
}

export function loadArgusProfile({
  subjectId,
  storage = browserLocalStorage(),
  randomId,
}: ProfileOptions): AnonymousProfile {
  const key = profileStorageKey(subjectId);
  const fallback = () => createDefaultProfile(randomId);
  const fallbackAndSave = () => {
    const profile = fallback();
    saveArgusProfile({ subjectId, profile, storage });
    return profile;
  };
  const stored = readVersionedRecord({
    storage,
    key,
    decode: (value) => decodeScopedProfileRecord(value, subjectId),
  });

  if (stored.status === 'ok') return stored.value.profile;
  if (stored.status === 'unavailable') return fallback();

  if (stored.status === 'invalid-record') {
    const migratedCurrent = migrateCurrentKeyRecord(storage, key, subjectId);
    if (migratedCurrent.status === 'unavailable') return fallback();
    if (migratedCurrent.status === 'migrated') return migratedCurrent.profile;
    wipeProfileNamespace(storage);
  }

  if (stored.status === 'missing') {
    const migratedLegacy = migrateLegacyProfileRecord(storage, key, subjectId);
    if (migratedLegacy.status === 'unavailable') return fallback();
    if (migratedLegacy.status === 'migrated') return migratedLegacy.profile;
    if (migratedLegacy.shouldWipe) wipeProfileNamespace(storage);
  } else {
    wipeProfileNamespace(storage);
  }

  return fallbackAndSave();
}

export function saveArgusProfile({
  subjectId,
  profile,
  storage = browserLocalStorage(),
}: SaveProfileOptions): boolean {
  if (profile.id === subjectId) return false;
  const username = profile.username.trim() || defaultAnonymousName(profile.id);
  const stored: StoredArgusProfile = {
    subjectId,
    profile: {
      id: profile.id,
      username,
      avatar: safeAvatarSrc(profile.avatar, username),
    },
  };
  return writeVersionedRecord({
    storage,
    key: profileStorageKey(subjectId),
    value: stored,
  }).ok;
}
