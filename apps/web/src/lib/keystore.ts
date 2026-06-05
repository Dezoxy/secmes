import {
  DEFAULT_ARGON2,
  MlsEngine,
  deserializeDeviceIdentity,
  deserializeDeviceKeys,
  deviceIdentity,
  openBackup,
  sealBackup,
  serializeDeviceIdentity,
  serializeDeviceKeys,
  type Argon2Params,
  type DeviceKeys,
  type SealedBackup,
} from '@argus/crypto';
import { openDB, type IDBPDatabase } from 'idb';

// SEALED at rest: the full device key material is stored in IndexedDB only as a passphrase-sealed blob
// (Argon2id + AES-256-GCM, checkpoint 21); unlocking requires the passphrase. The server RECOVERY
// artifact is a SEPARATE, narrower blob — identity-only (no one-time KeyPackage HPKE private keys) — so
// a leaked backup can't decrypt a retained Welcome (forward secrecy, key-backup.md §4). The full at-rest
// blob is never uploaded. See docs/threat-models/device-keystore.md + key-backup.md §4.

// Renamed from 'secmes-keystore' during the pre-launch rebrand. Safe to rename now: the web client is
// not shipped, so no real browser holds a 'secmes-keystore' to strand. If a client is EVER released
// under the old name before this lands, add a one-time copy-migration (open the old DB, copy device/self
// into this one, delete the old) BEFORE getOrCreateDevice mints a fresh device. See device-keystore.md.
const DB_NAME = 'argus-keystore';
// v1 stored an UNSEALED `{ identity, keys }` record at the same DB/store/key. v2 stores only the sealed
// blob. The shapes are incompatible: a stale v1 record would be misread as a sealed device and fail to
// unlock. The upgrade drops the legacy store so those unsealed secrets are also cleared from disk.
const DB_VERSION = 2;
const STORE = 'device';
const SELF = 'self'; // single device per user in v1 (multi-device is deferred, B2)

interface StoredDevice {
  identity: string;
  sealed: SealedBackup;
}

/** Shape-check a server-provided sealed blob before storing it (it's still GCM-authenticated on unseal). */
function isSealedBackup(v: unknown): v is SealedBackup {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  const p = b.params as Record<string, unknown> | undefined;
  return (
    b.v === 1 &&
    b.kdf === 'argon2id' &&
    typeof b.salt === 'string' &&
    typeof b.iv === 'string' &&
    typeof b.ciphertext === 'string' &&
    !!p &&
    typeof p.m === 'number' &&
    typeof p.t === 'number' &&
    typeof p.p === 'number'
  );
}

/** Client-side store for this device's MLS key material — sealed at rest under the user's passphrase. */
export class DeviceKeystore {
  private constructor(
    private readonly db: IDBPDatabase,
    private readonly engine: MlsEngine,
    private readonly argon: Argon2Params,
  ) {}

  static async open(
    engine?: MlsEngine,
    argon: Argon2Params = DEFAULT_ARGON2,
  ): Promise<DeviceKeystore> {
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // Coming from the unsealed v1 schema → drop the legacy store and its unsealed records. This is
        // best-effort at-rest clearing (the browser decides when backing pages are reclaimed), so a
        // recovered/fresh device should rotate its key regardless (key-backup.md §4). A fresh sealed
        // device is generated on next getOrCreateDevice; nothing in the dropped store can be unsealed.
        if (oldVersion > 0 && oldVersion < 2 && database.objectStoreNames.contains(STORE)) {
          database.deleteObjectStore(STORE);
        }
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      },
    });
    return new DeviceKeystore(db, engine ?? (await MlsEngine.create()), argon);
  }

  /**
   * The persisted device (unsealed with `passphrase`), or a freshly generated one — sealed + stored.
   * Single device per user; throws if the profile holds a device for a different identity, or if the
   * passphrase is wrong (unseal fails).
   */
  async getOrCreateDevice(identity: string, passphrase: string): Promise<DeviceKeys> {
    const existing = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (existing) return this.unseal(existing, identity, passphrase);

    const keys = await this.engine.generateDeviceKeys(identity);
    const sealed = await sealBackup(serializeDeviceKeys(keys), passphrase, this.argon);

    // Atomic put-if-absent: a racing first-run can't overwrite an already-sealed device.
    const tx = this.db.transaction(STORE, 'readwrite');
    const reread = (await tx.store.get(SELF)) as StoredDevice | undefined;
    if (!reread) await tx.store.put({ identity, sealed } satisfies StoredDevice, SELF);
    await tx.done;
    return reread ? this.unseal(reread, identity, passphrase) : keys;
  }

  /** The persisted device keys for `identity`, unsealed with `passphrase`; undefined if none yet. */
  async loadDevice(identity: string, passphrase: string): Promise<DeviceKeys | undefined> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (!stored) return undefined;
    return this.unseal(stored, identity, passphrase);
  }

  /**
   * The identity-only sealed artifact to upload for cross-device recovery (key-backup.md §4). Unseals the
   * local device with `passphrase`, strips it to identity material (no one-time KeyPackage HPKE private
   * keys), and re-seals that under the same passphrase. Forward-secret: a leak of this artifact can't
   * decrypt a retained Welcome. undefined if no device is stored yet.
   */
  async exportRecoveryArtifact(identity: string, passphrase: string): Promise<string | undefined> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (!stored) return undefined;
    const keys = await this.unseal(stored, identity, passphrase);
    const plaintext = serializeDeviceIdentity(this.engine.exportIdentity(keys));
    const sealed = await sealBackup(plaintext, passphrase, this.argon);
    plaintext.fill(0); // best-effort wipe of the transient identity plaintext after sealing
    return JSON.stringify(sealed);
  }

  /**
   * Restore on a fresh profile from an identity-only recovery artifact. Unseals with `passphrase`,
   * checks the embedded identity, then mints a FRESH device under the recovered signing identity and
   * stores it sealed at rest. Verification happens BEFORE the store is touched, so a wrong, tampered, or
   * wrong-identity artifact is rejected without stranding the profile. Refuses to clobber an existing
   * device (use `clearDevice` first). Returns the recovered working device; it must re-publish + re-join.
   */
  async importRecoveryArtifact(
    identity: string,
    sealedJson: string,
    passphrase: string,
  ): Promise<DeviceKeys> {
    const parsed: unknown = JSON.parse(sealedJson);
    if (!isSealedBackup(parsed)) throw new Error('invalid recovery artifact');

    // Authenticate + bind BEFORE persisting: unseal (GCM rejects wrong passphrase / tampering), confirm
    // the recovered identity, then mint a fresh device under that signing identity.
    const recovered = deserializeDeviceIdentity(await openBackup(parsed, passphrase));
    if (recovered.identity !== identity) {
      throw new Error('recovered identity does not match the requested identity');
    }
    const keys = await this.engine.deviceFromIdentity(recovered);
    const plaintext = serializeDeviceKeys(keys);
    const sealed = await sealBackup(plaintext, passphrase, this.argon);
    plaintext.fill(0); // best-effort wipe of the transient device plaintext after sealing

    // Atomic put-if-absent: a racing import — or an overlap with first-run generation — can't clobber an
    // existing device. Throw post-commit.
    const tx = this.db.transaction(STORE, 'readwrite');
    const existing = await tx.store.get(SELF);
    if (!existing) await tx.store.put({ identity, sealed } satisfies StoredDevice, SELF);
    await tx.done;
    if (existing) {
      throw new Error('keystore already holds a device; clear it before importing a backup');
    }
    return keys;
  }

  /** Remove the stored device — to recover from a bad import or reset this profile before re-importing. */
  async clearDevice(): Promise<void> {
    await this.db.delete(STORE, SELF);
  }

  private async unseal(
    stored: StoredDevice,
    identity: string,
    passphrase: string,
  ): Promise<DeviceKeys> {
    if (stored.identity !== identity) {
      throw new Error('keystore holds a device for a different identity');
    }
    const keys = deserializeDeviceKeys(await openBackup(stored.sealed, passphrase));
    // Check the identity embedded in the decrypted KeyPackage, not just the caller-supplied metadata, so
    // a recovery service that returns the wrong (genuine) sealed blob under this name — shared/reused
    // passphrase, account switch — can't silently hand back another identity's keys. This is a
    // confusion check, not full authenticity: proving a restored device is really `identity`'s is the
    // key-directory + fingerprint job (checkpoint 20, docs/threat-models/key-directory.md).
    if (deviceIdentity(keys) !== identity) {
      throw new Error('recovered device identity does not match the requested identity');
    }
    return keys;
  }
}
