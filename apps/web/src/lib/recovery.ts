// Account-recovery operations for the UI, over the sealed DeviceKeystore (Argon2id + AES-256-GCM).
//
// Key-loss is THE E2EE failure mode: without a recovery artifact + its passphrase, a lost device means
// lost access. The artifact is IDENTITY-ONLY (no one-time KeyPackage HPKE private keys), so a leaked
// artifact can't decrypt a retained Welcome — forward secrecy is preserved (key-backup.md §4). Nothing
// here uploads to the server (that's PUT /backups/me, which needs auth); this is the local seal +
// download + restore flow. `identity` is the SIGNED-IN account's id (`profile.userId`) — the SAME identity
// the device-provisioning gate seals the device under, so backup/restore and unlock operate on ONE device
// (the keystore holds a single `SELF` device and rejects a mismatched identity). RECOVERY_IDENTITY is only
// the demo fallback when no account is signed in.

import { DeviceExistsError, DeviceKeystore } from './keystore';
import { RestoreCommittedError } from './restore-errors';

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
 * download. `identity` is the signed-in account (matches the unlock gate's device). Idempotent for the
 * same passphrase; throws on a wrong passphrase for an existing device.
 */
export async function setUpRecovery(identity: string, passphrase: string): Promise<string> {
  const ks = await keystore();
  await ks.getOrCreateDevice(identity, passphrase);
  const artifact = await ks.exportRecoveryArtifact(identity, passphrase);
  if (!artifact) throw new Error('no device to export');
  return artifact;
}

/** Re-download the artifact for an already-set-up device (verifies the passphrase). */
export async function exportRecovery(identity: string, passphrase: string): Promise<string> {
  const artifact = await (await keystore()).exportRecoveryArtifact(identity, passphrase);
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
export async function restoreFromArtifact(
  identity: string,
  artifactJson: string,
  passphrase: string,
  activeKeystore?: DeviceKeystore,
): Promise<void> {
  // Run on the ACTIVE keystore instance when one is given (a signed-in restore), so its IN-MEMORY caches
  // (groupStateVersions / appendChains) are reset by clearDevice along with the IndexedDB stores. Otherwise
  // a post-remount rejoin would compare against a stale CAS version and throw GroupStateConflict, leaving the
  // Welcome pending. The recovery singleton is the fallback for the demo / no-active-session path.
  const ks = activeKeystore ?? (await keystore());
  try {
    await ks.importRecoveryArtifact(identity, artifactJson, passphrase);
  } catch (e) {
    if (e instanceof DeviceExistsError) {
      await ks.clearDevice(); // DESTRUCTIVE — the live device/group/history stores are now cleared
      try {
        await ks.importRecoveryArtifact(identity, artifactJson, passphrase);
      } catch (committed) {
        // The re-import failed AFTER the clear — the stores are already gone. Surface it distinctly so a
        // live caller RELOADS instead of preserving a now-stale session (recreating the corruption otherwise).
        throw new RestoreCommittedError(committed);
      }
    } else {
      throw e; // PRE-clear: an invalid artifact / wrong passphrase — the existing device is untouched
    }
  }
}
