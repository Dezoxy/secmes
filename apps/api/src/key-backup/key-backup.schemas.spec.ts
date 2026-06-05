import { describe, expect, it } from 'vitest';

import { StoreBackupSchema } from './key-backup.schemas.js';

describe('StoreBackupSchema', () => {
  it('accepts a non-empty blob within the 64 KiB cap', () => {
    expect(StoreBackupSchema.safeParse({ backup: 'sealed-blob' }).success).toBe(true);
  });

  it('rejects unknown keys (strict, fail-closed)', () => {
    expect(StoreBackupSchema.safeParse({ backup: 'x', extra: 'nope' }).success).toBe(false);
  });

  it('rejects an empty blob and one over the 64 KiB cap', () => {
    expect(StoreBackupSchema.safeParse({ backup: '' }).success).toBe(false);
    expect(StoreBackupSchema.safeParse({ backup: 'a'.repeat(65537) }).success).toBe(false);
  });
});
