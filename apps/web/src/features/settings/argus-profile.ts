import { generatedAvatar, safeAvatarSrc } from '../chat/seed';
import type { AnonymousProfile } from './SettingsPanel';

export const ARGUS_PROFILE_STORAGE_PREFIX = 'argus:v1:profile';
export const LEGACY_ARGUS_PROFILE_STORAGE_KEY = 'argus.anonymousProfile.v1';

type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface StoredArgusProfile {
  subjectId: string;
  profile: AnonymousProfile;
}

interface ProfileOptions {
  subjectId: string;
  storage?: ProfileStorage;
  randomId?: () => string;
}

interface SaveProfileOptions {
  subjectId: string;
  profile: AnonymousProfile;
  storage?: ProfileStorage;
}

export function profileStorageKey(subjectId: string): string {
  return `${ARGUS_PROFILE_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}`;
}

function browserStorage(): ProfileStorage {
  return window.localStorage;
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

function readStoredProfile(raw: string | null, subjectId: string): AnonymousProfile | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.subjectId !== subjectId || !isRecord(parsed.profile)) {
    return null;
  }

  const profile = parsed.profile;
  if (typeof profile.id !== 'string' || profile.id === subjectId) return null;

  const username =
    typeof profile.username === 'string' && profile.username.trim()
      ? profile.username.trim()
      : defaultAnonymousName(profile.id);
  const avatar = typeof profile.avatar === 'string' ? profile.avatar : undefined;

  return {
    id: profile.id,
    username,
    avatar: safeAvatarSrc(avatar, username),
  };
}

export function loadArgusProfile({
  subjectId,
  storage = browserStorage(),
  randomId,
}: ProfileOptions): AnonymousProfile {
  try {
    const stored = readStoredProfile(storage.getItem(profileStorageKey(subjectId)), subjectId);
    if (stored) return stored;
    const fallback = createDefaultProfile(randomId);
    saveArgusProfile({ subjectId, profile: fallback, storage });
    return fallback;
  } catch {
    return createDefaultProfile(randomId);
  }
}

export function saveArgusProfile({
  subjectId,
  profile,
  storage = browserStorage(),
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
  try {
    storage.setItem(profileStorageKey(subjectId), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}
