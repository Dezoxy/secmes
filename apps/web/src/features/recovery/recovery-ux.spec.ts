import { describe, expect, it } from 'vitest';
import { ARGUS_STORAGE_VERSION } from '../../lib/persistence';
import {
  RECOVERY_REMINDER_STORAGE_KEY,
  getRecoveryPassphraseStrength,
  readRecoveryReminderDismissed,
  writeRecoveryReminderDismissed,
} from './recovery-ux';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class BlockedStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }

  override setItem(): void {
    throw new DOMException('blocked', 'SecurityError');
  }
}

describe('recovery UX helpers', () => {
  it('treats missing, corrupt, and blocked reminder storage as not dismissed', () => {
    const storage = new MemoryStorage();

    expect(readRecoveryReminderDismissed(storage)).toBe(false);

    storage.setItem(RECOVERY_REMINDER_STORAGE_KEY, '{bad json');
    expect(readRecoveryReminderDismissed(storage)).toBe(false);

    expect(readRecoveryReminderDismissed(new BlockedStorage())).toBe(false);
  });

  it('stores only the versioned reminder dismissal flag', () => {
    const storage = new MemoryStorage();

    expect(writeRecoveryReminderDismissed(true, storage)).toEqual({ ok: true });
    expect(readRecoveryReminderDismissed(storage)).toBe(true);
    expect(JSON.parse(storage.getItem(RECOVERY_REMINDER_STORAGE_KEY) ?? '{}')).toEqual({
      version: ARGUS_STORAGE_VERSION,
      data: { dismissed: true },
    });
  });

  it('keeps the passphrase strength meter client-only and length-sensitive', () => {
    expect(getRecoveryPassphraseStrength('').label).toBe('Empty');
    expect(getRecoveryPassphraseStrength('short').label).toBe('Weak');
    expect(getRecoveryPassphraseStrength('eight888').label).toBe('Fair');
    expect(getRecoveryPassphraseStrength('longer-Passphrase-42!').label).toBe('Strong');
  });
});
