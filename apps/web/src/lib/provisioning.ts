// Device provisioning (live client loop, Slice 2): keep the device's one-time KeyPackage pool full and
// PUBLISHED to the key directory (#19) so peers can claim one to add this device to a group. Only PUBLIC
// key material leaves the device; the pool privates stay sealed at rest (retained for join, Slice 4).

import { deviceSignaturePublicKeyB64, serializeKeyPackage, type DeviceKeys } from '@argus/crypto';

import { publishKeyPackages, type PublishResult } from './api';
import type { DeviceKeystore } from './keystore';

/**
 * Ensure the device's one-time KeyPackage pool is full (sealed at rest) and published to the directory
 * so peers can claim a package to add this device. Idempotent — safe on every login (the server dedups
 * already-published packages). Returns the pool (DeviceKeys with retained privates) + the publish result.
 */
export async function provisionDevice(
  keystore: DeviceKeystore,
  device: DeviceKeys,
  passphrase: string,
): Promise<{ pool: DeviceKeys[]; result: PublishResult }> {
  const pool = await keystore.ensurePool(device, passphrase);
  const result = await publishKeyPackages(
    deviceSignaturePublicKeyB64(device),
    pool.map((member) => serializeKeyPackage(member.publicPackage)),
  );
  return { pool, result };
}
