export const ARGUS_STORAGE_VERSION = 1;
export const ARGUS_STORAGE_PREFIX = `argus:v${ARGUS_STORAGE_VERSION}`;
export const LEGACY_ARGUS_PROFILE_STORAGE_KEY = 'argus.anonymousProfile.v1';
export const LEGACY_ACCENT_STORAGE_KEY = 'argus.accentColor.v1';
export const LEGACY_FONT_SIZE_STORAGE_KEY = 'argus.fontSizeLevel.v1';

export const KNOWN_LEGACY_ARGUS_STORAGE_KEYS = [
  LEGACY_ARGUS_PROFILE_STORAGE_KEY,
  LEGACY_ACCENT_STORAGE_KEY,
  LEGACY_FONT_SIZE_STORAGE_KEY,
] as const;

const BLOCKED_LOCAL_STORAGE_AREAS = new Set([
  'messages',
  'plaintext-messages',
  'auth',
  'tokens',
  'private-keys',
  'keys',
  'passphrases',
  'presigned-urls',
  'decrypted-attachments',
  'attachments',
]);

export type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export type SafeJsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid-json' };

export type StorageReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'invalid-json' }
  | { status: 'version-mismatch' }
  | { status: 'invalid-record' };

export type StorageWriteFailureReason = 'quota-exceeded' | 'unavailable';

export type StorageWriteResult = { ok: true } | { ok: false; reason: StorageWriteFailureReason };

export type LegacyMigrationResult<T> =
  | { status: 'migrated'; value: T }
  | { status: 'missing' }
  | { status: 'invalid-json' }
  | { status: 'invalid-record' }
  | { status: 'write-failed'; reason: StorageWriteFailureReason };

interface VersionedRecord<T> {
  version: number;
  data: T;
}

interface ReadVersionedOptions<T> {
  storage: Pick<Storage, 'getItem'>;
  key: string;
  decode: (value: unknown) => T | null;
}

type ReadLegacyOptions<T> = ReadVersionedOptions<T>;

interface WriteVersionedOptions<T> {
  storage: Pick<Storage, 'setItem'>;
  key: string;
  value: T;
}

interface MigrateLegacyOptions<T> {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  legacyKey: string;
  targetKey: string;
  decode: (value: unknown) => T | null;
}

interface WipeOptions {
  prefixes?: readonly string[];
  legacyKeys?: readonly string[];
}

export function versionedStorageKey(area: string, scope?: string): string {
  const cleanArea = area.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (BLOCKED_LOCAL_STORAGE_AREAS.has(cleanArea)) {
    throw new Error('This data class is not allowed in persistent browser storage.');
  }
  return scope === undefined
    ? `${ARGUS_STORAGE_PREFIX}:${cleanArea}`
    : `${ARGUS_STORAGE_PREFIX}:${cleanArea}:${encodeURIComponent(scope)}`;
}

export function browserLocalStorage(): BrowserStorage {
  return window.localStorage;
}

export function safeJsonParse(raw: string): SafeJsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

export function readVersionedRecord<T>({
  storage,
  key,
  decode,
}: ReadVersionedOptions<T>): StorageReadResult<T> {
  const raw = storage.getItem(key);
  if (raw === null) return { status: 'missing' };

  const parsed = safeJsonParse(raw);
  if (!parsed.ok) return { status: 'invalid-json' };
  if (!isVersionedRecord(parsed.value)) return { status: 'invalid-record' };
  if (parsed.value.version !== ARGUS_STORAGE_VERSION) return { status: 'version-mismatch' };

  const value = decode(parsed.value.data);
  return value ? { status: 'ok', value } : { status: 'invalid-record' };
}

export function readLegacyJsonRecord<T>({
  storage,
  key,
  decode,
}: ReadLegacyOptions<T>): StorageReadResult<T> {
  const raw = storage.getItem(key);
  if (raw === null) return { status: 'missing' };

  const parsed = safeJsonParse(raw);
  if (!parsed.ok) return { status: 'invalid-json' };

  const value = decode(parsed.value);
  return value ? { status: 'ok', value } : { status: 'invalid-record' };
}

export function writeVersionedRecord<T>({
  storage,
  key,
  value,
}: WriteVersionedOptions<T>): StorageWriteResult {
  const record: VersionedRecord<T> = {
    version: ARGUS_STORAGE_VERSION,
    data: value,
  };

  try {
    storage.setItem(key, JSON.stringify(record));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: isQuotaExceeded(error) ? 'quota-exceeded' : 'unavailable' };
  }
}

export function migrateLegacyJsonRecord<T>({
  storage,
  legacyKey,
  targetKey,
  decode,
}: MigrateLegacyOptions<T>): LegacyMigrationResult<T> {
  const legacy = readLegacyJsonRecord({ storage, key: legacyKey, decode });
  if (legacy.status === 'version-mismatch') return { status: 'invalid-record' };
  if (legacy.status !== 'ok') return legacy;

  const written = writeVersionedRecord({ storage, key: targetKey, value: legacy.value });
  if (!written.ok) return { status: 'write-failed', reason: written.reason };

  try {
    storage.removeItem(legacyKey);
  } catch {
    // The migrated record is already persisted. A stale legacy key is harmless and will be ignored.
  }

  return { status: 'migrated', value: legacy.value };
}

export function wipeKnownArgusStorage(
  storage: BrowserStorage,
  {
    prefixes = [`${ARGUS_STORAGE_PREFIX}:`],
    legacyKeys = KNOWN_LEGACY_ARGUS_STORAGE_KEYS,
  }: WipeOptions = {},
): string[] {
  const legacy = new Set(legacyKeys);
  const keys: string[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix)) || legacy.has(key)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort cleanup; callers still fall back to safe defaults.
    }
  }

  return keys;
}

function isVersionedRecord(value: unknown): value is VersionedRecord<unknown> {
  return typeof value === 'object' && value !== null && 'version' in value && 'data' in value;
}

function isQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}
