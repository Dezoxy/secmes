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
): AnonymousProfile | null {
  const legacy = readLegacyJsonRecord({
    storage,
    key,
    decode: (value) => decodeScopedProfileRecord(value, subjectId),
  });
  if (legacy.status !== 'ok') return null;

  writeVersionedRecord({ storage, key, value: legacy.value });
  return legacy.value.profile;
}

function migrateLegacyProfileRecord(
  storage: BrowserStorage,
  key: string,
  subjectId: string,
): AnonymousProfile | null {
  const migrated = migrateLegacyJsonRecord({
    storage,
    legacyKey: LEGACY_ARGUS_PROFILE_STORAGE_KEY,
    targetKey: key,
    decode: (value) => decodeLegacyProfileRecord(value, subjectId),
  });
  return migrated.status === 'migrated' ? migrated.value.profile : null;
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
  const stored = readVersionedRecord({
    storage,
    key,
    decode: (value) => decodeScopedProfileRecord(value, subjectId),
  });

  if (stored.status === 'ok') return stored.value.profile;

  if (stored.status === 'invalid-record') {
    const migratedCurrent = migrateCurrentKeyRecord(storage, key, subjectId);
    if (migratedCurrent) return migratedCurrent;
    wipeProfileNamespace(storage);
  }

  if (stored.status === 'missing') {
    const hadLegacyProfile = storage.getItem(LEGACY_ARGUS_PROFILE_STORAGE_KEY) !== null;
    const migratedLegacy = migrateLegacyProfileRecord(storage, key, subjectId);
    if (migratedLegacy) return migratedLegacy;
    if (hadLegacyProfile) wipeProfileNamespace(storage);
  } else {
    wipeProfileNamespace(storage);
  }

  const fallback = createDefaultProfile(randomId);
  saveArgusProfile({ subjectId, profile: fallback, storage });
  return fallback;
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
