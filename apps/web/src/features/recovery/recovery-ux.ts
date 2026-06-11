import {
  browserLocalStorage,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
  type StorageWriteResult,
} from '../../lib/persistence';

export const MIN_RECOVERY_PASSPHRASE_LENGTH = 8;
export const RECOVERY_REMINDER_STORAGE_KEY = versionedStorageKey('recovery-reminder');

// Whether the recovery file was also saved to the user's account (PUT /backups/me):
//   'saved'      — the server copy was stored
//   'failed'     — signed in, but the upload failed (network/token); the local file is the only copy
//   'local-only' — no signed-in profile, so no server copy was attempted (demo / offline session)
export type BackupUploadOutcome = 'saved' | 'failed' | 'local-only';

const RECOVERY_HISTORY_NOTE =
  'It restores your messaging identity for future messages only, not past message history.';

/**
 * Whether to attempt a server backup upload. Gate on the signed-in PROFILE, not just an OIDC session:
 * the artifact is sealed under `profile.userId`, so with no profile it is sealed under the demo identity
 * and must NOT be uploaded into the real user's server row (it would fail on restore). See RecoveryPanel.
 */
export function shouldUploadBackup(hasProfile: boolean): boolean {
  return hasProfile;
}

/** The success message after a recovery-file download, honest about whether the server copy was saved. */
export function backupDownloadMessage(outcome: BackupUploadOutcome): string {
  switch (outcome) {
    case 'saved':
      return `Recovery file saved to your account and downloaded. Store the file somewhere safe too. ${RECOVERY_HISTORY_NOTE}`;
    case 'failed':
      return `Recovery file downloaded, but it could not be saved to your account right now — keep this file safe, it is your only copy. ${RECOVERY_HISTORY_NOTE}`;
    case 'local-only':
      return `Recovery file downloaded. Store it somewhere safe. ${RECOVERY_HISTORY_NOTE}`;
  }
}

export type RecoveryPassphraseScore = 0 | 1 | 2 | 3 | 4;

export interface RecoveryPassphraseStrength {
  score: RecoveryPassphraseScore;
  label: 'Empty' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  hint: string;
}

interface RecoveryReminderState {
  dismissed: boolean;
}

type RecoveryReminderReadStorage = Pick<Storage, 'getItem'>;
type RecoveryReminderWriteStorage = Pick<Storage, 'setItem'>;

const RECOVERY_STRENGTH_LABELS: Record<
  RecoveryPassphraseScore,
  RecoveryPassphraseStrength['label']
> = {
  0: 'Empty',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

const RECOVERY_STRENGTH_HINTS: Record<RecoveryPassphraseScore, string> = {
  0: `Use at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters.`,
  1: 'Use a longer unique phrase before downloading a recovery file.',
  2: 'Add more length and a mix of words, numbers, or symbols.',
  3: 'Good. Keep using a phrase you do not use anywhere else.',
  4: 'Strong. Store this passphrase separately from the recovery file.',
};

export function readRecoveryReminderDismissed(storage?: RecoveryReminderReadStorage): boolean {
  const target = storage ?? resolveBrowserLocalStorage();
  if (!target) return false;

  const record = readVersionedRecord({
    storage: target,
    key: RECOVERY_REMINDER_STORAGE_KEY,
    decode: decodeRecoveryReminderState,
  });

  return record.status === 'ok' ? record.value.dismissed : false;
}

export function writeRecoveryReminderDismissed(
  dismissed: boolean,
  storage?: RecoveryReminderWriteStorage,
): StorageWriteResult {
  const target = storage ?? resolveBrowserLocalStorage();
  if (!target) return { ok: false, reason: 'unavailable' };

  return writeVersionedRecord({
    storage: target,
    key: RECOVERY_REMINDER_STORAGE_KEY,
    value: { dismissed },
  });
}

export function getRecoveryPassphraseStrength(passphrase: string): RecoveryPassphraseStrength {
  if (passphrase.trim().length === 0) return recoveryPassphraseStrength(0);

  if (passphrase.length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
    return recoveryPassphraseStrength(1);
  }

  let points = 1;
  if (passphrase.length >= 12) points += 1;
  if (passphrase.length >= 16) points += 1;

  const characterGroups = [
    /[a-z]/.test(passphrase),
    /[A-Z]/.test(passphrase),
    /\d/.test(passphrase),
    /[^A-Za-z0-9\s]/.test(passphrase),
    /\s/.test(passphrase.trim()),
  ].filter(Boolean).length;

  if (characterGroups >= 2) points += 1;
  if (characterGroups >= 4) points += 1;

  return recoveryPassphraseStrength(clampRecoveryScore(points));
}

function recoveryPassphraseStrength(score: RecoveryPassphraseScore): RecoveryPassphraseStrength {
  return {
    score,
    label: RECOVERY_STRENGTH_LABELS[score],
    hint: RECOVERY_STRENGTH_HINTS[score],
  };
}

function clampRecoveryScore(score: number): RecoveryPassphraseScore {
  if (score <= 0) return 0;
  if (score >= 4) return 4;
  return score as RecoveryPassphraseScore;
}

function decodeRecoveryReminderState(value: unknown): RecoveryReminderState | null {
  return isRecord(value) && typeof value.dismissed === 'boolean'
    ? { dismissed: value.dismissed }
    : null;
}

function resolveBrowserLocalStorage():
  | (RecoveryReminderReadStorage & RecoveryReminderWriteStorage)
  | null {
  if (typeof window === 'undefined') return null;

  try {
    return browserLocalStorage();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
