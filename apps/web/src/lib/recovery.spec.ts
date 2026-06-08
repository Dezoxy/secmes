import { describe, expect, it, vi } from 'vitest';

import { DeviceExistsError, type DeviceKeystore } from './keystore';
import { restoreFromArtifact } from './recovery';
import { RestoreCommittedError } from './restore-errors';

// A minimal keystore double, passed as the ACTIVE keystore so the real singleton is never touched.
const ks = (
  importRecoveryArtifact: ReturnType<typeof vi.fn>,
  clearDevice = vi.fn(),
): DeviceKeystore => ({ importRecoveryArtifact, clearDevice }) as unknown as DeviceKeystore;

describe('restoreFromArtifact — destructive boundary', () => {
  it('a PRE-clear failure (bad artifact / wrong passphrase) propagates raw and never clears', async () => {
    const bad = new Error('wrong passphrase');
    const clearDevice = vi.fn();
    const importRecoveryArtifact = vi.fn().mockRejectedValueOnce(bad);
    await expect(
      restoreFromArtifact('me', 'ART', 'pass', ks(importRecoveryArtifact, clearDevice)),
    ).rejects.toBe(bad);
    expect(clearDevice).not.toHaveBeenCalled(); // session-preserving: nothing was wiped
  });

  it('a re-import failure AFTER the clear surfaces as RestoreCommittedError', async () => {
    const clearDevice = vi.fn();
    const importRecoveryArtifact = vi
      .fn()
      .mockRejectedValueOnce(new DeviceExistsError()) // first import → a device already exists
      .mockRejectedValueOnce(new Error('IndexedDB write failed')); // second import (post-clear) fails
    await expect(
      restoreFromArtifact('me', 'ART', 'pass', ks(importRecoveryArtifact, clearDevice)),
    ).rejects.toBeInstanceOf(RestoreCommittedError);
    expect(clearDevice).toHaveBeenCalledTimes(1); // the destructive clear DID run
  });

  it('a clean import (no existing device) resolves', async () => {
    const importRecoveryArtifact = vi.fn().mockResolvedValue(undefined);
    await expect(
      restoreFromArtifact('me', 'ART', 'pass', ks(importRecoveryArtifact)),
    ).resolves.toBeUndefined();
  });
});
