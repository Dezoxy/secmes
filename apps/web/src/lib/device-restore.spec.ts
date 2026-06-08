import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceKeys } from '@argus/crypto';

// Mock the three collaborators so we can assert orchestration ORDER + the best-effort revoke.
vi.mock('./recovery', () => ({ restoreFromArtifact: vi.fn() }));
vi.mock('./api', () => ({ revokeKeyPackages: vi.fn() }));
vi.mock('./provisioning', () => ({ provisionDevice: vi.fn() }));
vi.mock('@argus/crypto', () => ({ deviceSignaturePublicKeyB64: vi.fn(() => 'SIGPUB') }));

import { revokeKeyPackages } from './api';
import { RestoreCommittedError, restoreAndProvision } from './device-restore';
import type { DeviceKeystore } from './keystore';
import { provisionDevice } from './provisioning';
import { restoreFromArtifact } from './recovery';

const fakeDevice = { id: 'dev' } as unknown as DeviceKeys;
const loadDevice = vi.fn();
const fakeKeystore = { loadDevice } as unknown as DeviceKeystore;
const provisionResult = {
  pool: [fakeDevice],
  result: { deviceId: 'd', published: 1, available: 1 },
};

describe('restoreAndProvision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadDevice.mockResolvedValue(fakeDevice);
    vi.mocked(provisionDevice).mockResolvedValue(provisionResult);
    vi.mocked(revokeKeyPackages).mockResolvedValue({ revoked: 2 });
  });

  it('restores → revokes stale packages → publishes a fresh pool, in that order', async () => {
    const order: string[] = [];
    vi.mocked(restoreFromArtifact).mockImplementation(async () => {
      order.push('restore');
    });
    vi.mocked(revokeKeyPackages).mockImplementation(async () => {
      order.push('revoke');
      return { revoked: 2 };
    });
    vi.mocked(provisionDevice).mockImplementation(async () => {
      order.push('provision');
      return provisionResult;
    });

    const res = await restoreAndProvision(fakeKeystore, 'me', 'ARTIFACT', 'pass');
    // Revoke MUST run before provision — else it would delete the freshly-published pool.
    expect(order).toEqual(['restore', 'revoke', 'provision']);
    expect(vi.mocked(revokeKeyPackages)).toHaveBeenCalledWith('SIGPUB');
    // The ACTIVE keystore is threaded into restore so clearDevice resets ITS caches (no GroupStateConflict).
    expect(vi.mocked(restoreFromArtifact)).toHaveBeenCalledWith(
      'me',
      'ARTIFACT',
      'pass',
      fakeKeystore,
    );
    expect(res.device).toBe(fakeDevice);
  });

  it('is best-effort: a revoke failure still provisions and does not throw', async () => {
    vi.mocked(revokeKeyPackages).mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(restoreAndProvision(fakeKeystore, 'me', 'ARTIFACT', 'pass')).resolves.toBeTruthy();
    expect(vi.mocked(provisionDevice)).toHaveBeenCalled(); // provisioning still ran
    warn.mockRestore();
  });

  it('a PRE-clear failure (bad artifact) propagates raw, so the caller preserves the session', async () => {
    // restoreFromArtifact throws BEFORE any destructive clear — must NOT be wrapped as RestoreCommittedError.
    const bad = new Error('wrong passphrase');
    vi.mocked(restoreFromArtifact).mockRejectedValueOnce(bad);
    await expect(restoreAndProvision(fakeKeystore, 'me', 'ARTIFACT', 'pass')).rejects.toBe(bad);
    expect(loadDevice).not.toHaveBeenCalled();
    expect(vi.mocked(provisionDevice)).not.toHaveBeenCalled();
  });

  it('a POST-clear publish failure surfaces as RestoreCommittedError (caller must reload)', async () => {
    vi.mocked(provisionDevice).mockRejectedValueOnce(new Error('api down'));
    await expect(
      restoreAndProvision(fakeKeystore, 'me', 'ARTIFACT', 'pass'),
    ).rejects.toBeInstanceOf(RestoreCommittedError);
  });

  it('a no-device-after-restore is a committed error (stores already replaced)', async () => {
    loadDevice.mockResolvedValueOnce(null);
    await expect(
      restoreAndProvision(fakeKeystore, 'me', 'ARTIFACT', 'pass'),
    ).rejects.toBeInstanceOf(RestoreCommittedError);
    expect(vi.mocked(provisionDevice)).not.toHaveBeenCalled();
  });
});
