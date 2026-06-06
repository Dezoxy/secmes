// Account-recovery operations for the UI, over the sealed DeviceKeystore (Argon2id + AES-256-GCM).
//
// Key-loss is THE E2EE failure mode: without a recovery artifact + its passphrase, a lost device means
// lost access. The artifact is IDENTITY-ONLY (no one-time KeyPackage HPKE private keys), so a leaked
// artifact can't decrypt a retained Welcome — forward secrecy is preserved (key-backup.md §4). Nothing
// here uploads to the server (that's PUT /backups/me, which needs auth); this is the local seal +
// download + restore flow. The identity is a fixed demo value until the signed-in account supplies one.

import { DeviceExistsError, DeviceKeystore } from './keystore';

export const RECOVERY_IDENTITY = 'you@argus.local';

let keystorePromise: Promise<DeviceKeystore> | null = null;
function keystore(): Promise<DeviceKeystore> {
  keystorePromise ??= DeviceKeystore.open();
  return keystorePromise;
}

/** Has the user set up recovery (is there a sealed device)? Metadata only — no passphrase needed. */
export async function recoveryIsSetUp(): Promise<boolean> {
  return (await keystore()).hasDevice();
}

/**
 * Ensure a sealed device exists under `passphrase`, then return the identity-only recovery artifact to
 * download. Idempotent for the same passphrase; throws on a wrong passphrase for an existing device.
 */
export async function setUpRecovery(passphrase: string): Promise<string> {
  const ks = await keystore();
  await ks.getOrCreateDevice(RECOVERY_IDENTITY, passphrase);
  const artifact = await ks.exportRecoveryArtifact(RECOVERY_IDENTITY, passphrase);
  if (!artifact) throw new Error('no device to export');
  return artifact;
}

/** Re-download the artifact for an already-set-up device (verifies the passphrase). */
export async function exportRecovery(passphrase: string): Promise<string> {
  const artifact = await (await keystore()).exportRecoveryArtifact(RECOVERY_IDENTITY, passphrase);
  if (!artifact) throw new Error('recovery is not set up yet');
  return artifact;
}

/**
 * Restore from a recovery artifact. Safe to call whether or not a device already exists, and NEVER
 * wipes the existing device on a bad passphrase / file. The keystore verifies the artifact (passphrase
 * + identity) BEFORE its no-clobber guard, so a DeviceExistsError means the artifact is VALID but a
 * device exists — only then is it safe to clear + re-import. Any other error means nothing was verified,
 * so we rethrow without touching the stored device.
 */
export async function restoreFromArtifact(artifactJson: string, passphrase: string): Promise<void> {
  const ks = await keystore();
  try {
    await ks.importRecoveryArtifact(RECOVERY_IDENTITY, artifactJson, passphrase);
  } catch (e) {
    if (e instanceof DeviceExistsError) {
      await ks.clearDevice();
      await ks.importRecoveryArtifact(RECOVERY_IDENTITY, artifactJson, passphrase);
    } else {
      throw e; // invalid artifact — the existing device is untouched
    }
  }
}
