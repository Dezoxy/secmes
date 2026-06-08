// The single "restore a device + heal its directory presence" flow, shared by the unlock gate
// (DeviceContext.restore) and the Settings recovery panel (#20) so neither path can drift. Restore the
// device from the recovery artifact, then REVOKE the old device's now-unopenable KeyPackages (best-effort)
// BEFORE publishing a fresh pool: a device's signature key is stable across restore, so the OLD packages
// published under it are still claimable, but their one-time HPKE privates were discarded — a peer could
// claim a dead package and seal a Welcome this device can never open (device-provisioning §6).

import { deviceSignaturePublicKeyB64, type DeviceKeys } from '@argus/crypto';

import { revokeKeyPackages, type PublishResult } from './api';
import type { DeviceKeystore } from './keystore';
import { provisionDevice } from './provisioning';
import { restoreFromArtifact } from './recovery';

export async function restoreAndProvision(
  keystore: DeviceKeystore,
  identity: string,
  artifactJson: string,
  passphrase: string,
): Promise<{ device: DeviceKeys; pool: DeviceKeys[]; result: PublishResult }> {
  await restoreFromArtifact(identity, artifactJson, passphrase);
  const device = await keystore.loadDevice(identity, passphrase);
  if (!device) throw new Error('restore did not produce a device');
  // Best-effort: a failed revoke only leaves the self-healing residual — it must NOT block the restore.
  try {
    await revokeKeyPackages(deviceSignaturePublicKeyB64(device));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('key-package revoke after restore failed (stale packages remain; self-heal)', e);
  }
  const { pool, result } = await provisionDevice(keystore, device, passphrase);
  return { device, pool, result };
}
