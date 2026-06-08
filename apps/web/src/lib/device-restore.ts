// The single "restore a device + heal its directory presence" flow, shared by the unlock gate
// (DeviceContext.restore) and the Settings recovery panel (#20). Restore the device from the recovery
// artifact, then REVOKE the old device's now-unopenable KeyPackages (best-effort) BEFORE publishing a fresh
// pool: a device's signature key is stable across restore, so the OLD packages published under it are still
// claimable, but their one-time HPKE privates were discarded — a peer could claim a dead package and seal a
// Welcome this device can never open (device-provisioning §6).
//
// FAILURE CONTRACT (load-bearing for a Settings restore on a LIVE session): `restoreFromArtifact` is the
// DESTRUCTIVE boundary — on a valid artifact for an existing device it CLEARS the active device/group/history
// stores before re-importing. A bad artifact/passphrase throws from it BEFORE any clear, so the caller can
// safely keep its current session. Anything that fails AFTER it (load/revoke-fatal/publish) is wrapped in
// `RestoreCommittedError`: the stores are already replaced, so a live caller must RELOAD rather than pretend
// the session is intact.

import { deviceSignaturePublicKeyB64, type DeviceKeys } from '@argus/crypto';

import { revokeKeyPackages, type PublishResult } from './api';
import type { DeviceKeystore } from './keystore';
import { provisionDevice } from './provisioning';
import { restoreFromArtifact } from './recovery';

/** Thrown when the artifact WAS applied (the active stores are already replaced) but a post-restore step
 *  failed. A live caller must reload — its in-memory session is now stale on the cleared stores. */
export class RestoreCommittedError extends Error {
  constructor(readonly cause: unknown) {
    super('restore applied but a post-restore step failed');
    this.name = 'RestoreCommittedError';
  }
}

export async function restoreAndProvision(
  keystore: DeviceKeystore,
  identity: string,
  artifactJson: string,
  passphrase: string,
): Promise<{ device: DeviceKeys; pool: DeviceKeys[]; result: PublishResult }> {
  // Pre-clear: a bad artifact/passphrase throws HERE (the original error), BEFORE any destructive change, so
  // the caller can preserve its current session. Pass the ACTIVE keystore so its in-memory caches reset with
  // the cleared stores (else a post-remount rejoin hits a stale CAS version → GroupStateConflict).
  await restoreFromArtifact(identity, artifactJson, passphrase, keystore);
  // Committed past here — the active stores are replaced. Best-effort revoke + publish (both self-heal on the
  // next login). Any failure now is surfaced as RestoreCommittedError so a live caller reloads.
  try {
    const device = await keystore.loadDevice(identity, passphrase);
    if (!device) throw new Error('restore did not produce a device');
    try {
      await revokeKeyPackages(deviceSignaturePublicKeyB64(device));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('key-package revoke after restore failed (stale packages remain; self-heal)', e);
    }
    const { pool, result } = await provisionDevice(keystore, device, passphrase);
    return { device, pool, result };
  } catch (e) {
    throw new RestoreCommittedError(e);
  }
}
