// Device provisioning (live client loop, Slice 2): keep the device's one-time KeyPackage pool full and
// PUBLISHED to the key directory (#19) so peers can claim one to add this device to a group. Only PUBLIC
// key material leaves the device; the pool privates stay sealed at rest (retained for join, Slice 4).

import { deviceSignaturePublicKeyB64, serializeKeyPackage, type DeviceKeys } from '@argus/crypto';

import { publishKeyPackages, type PublishResult } from './api';
import { POOL_TARGET, type DeviceKeystore } from './keystore';

const MAX_REPLENISH_ROUNDS = 5; // bound the top-up loop (normally 0–1 rounds)
const POOL_PUBLISH_BATCH = 100; // matches the server's PublishKeyPackagesSchema max(100) per request

const publicKeyPackages = (pool: DeviceKeys[]): string[] =>
  pool.map((member) => serializeKeyPackage(member.publicPackage));

/**
 * Publish `members`' public KeyPackages in batches within the server's per-request limit. The retained
 * pool grows over its lifetime (claimed members' privates are kept until their Welcome is joined), so it
 * can exceed the limit — chunk so provisioning never gets rejected. Returns the LAST batch's result;
 * `available` is the device's total unclaimed count (independent of which batch reported it).
 */
async function publishInBatches(
  signaturePublicKey: string,
  members: DeviceKeys[],
): Promise<PublishResult> {
  const keyPackages = publicKeyPackages(members);
  let result: PublishResult | undefined;
  for (let i = 0; i < keyPackages.length; i += POOL_PUBLISH_BATCH) {
    result = await publishKeyPackages(
      signaturePublicKey,
      keyPackages.slice(i, i + POOL_PUBLISH_BATCH),
    );
  }
  if (!result) throw new Error('no key packages to publish');
  return result;
}

/**
 * Ensure the device keeps `POOL_TARGET` one-time KeyPackages AVAILABLE (unclaimed) in the directory so
 * peers can claim one to add this device. Publishes the sealed pool (idempotent — the server dedups), then
 * REPLENISHES: if peers claimed some while this device was offline, re-publishing the claimed packages
 * inserts nothing, so we mint + publish FRESH replacements until the server reports `available` back at
 * target. Every minted member's private is retained sealed, so any resulting Welcome can still be joined.
 * Returns the (growing) pool + the latest publish result.
 */
export async function provisionDevice(
  keystore: DeviceKeystore,
  device: DeviceKeys,
  unlockKey: CryptoKey,
): Promise<{ pool: DeviceKeys[]; result: PublishResult }> {
  const signaturePublicKey = deviceSignaturePublicKeyB64(device);
  let pool = await keystore.ensurePool(device, unlockKey, POOL_TARGET);
  let result = await publishInBatches(signaturePublicKey, pool);

  for (let round = 0; round < MAX_REPLENISH_ROUNDS && result.available < POOL_TARGET; round += 1) {
    const before = pool.length;
    pool = await keystore.ensurePool(device, unlockKey, before + (POOL_TARGET - result.available));
    const fresh = pool.slice(before);
    if (fresh.length === 0) break;
    result = await publishInBatches(signaturePublicKey, fresh);
    if (result.published === 0) break; // nothing new took (e.g. the server per-device cap) — stop
  }
  return { pool, result };
}
