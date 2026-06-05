import { openDB, type IDBPDatabase } from 'idb';

import { MlsEngine, type DeviceKeys } from '@secmes/crypto';

// ⚠️ UNSEALED AT REST. Device private key material is persisted to IndexedDB (origin-isolated) but
// NOT yet encrypted. Checkpoints 21–22 MUST wrap it with the passphrase-derived (Argon2id) seal
// before any real message history persists. See docs/threat-models/device-keystore.md.

const DB_NAME = 'secmes-keystore';
const STORE = 'device';
const SELF = 'self'; // single device per user in v1 (multi-device is deferred, B2)

interface StoredDevice {
  identity: string;
  keys: DeviceKeys;
}

/** Guard against returning a device that belongs to a different identity than requested. */
function assertIdentity(record: StoredDevice, identity: string): DeviceKeys {
  if (record.identity !== identity) {
    throw new Error('keystore holds a device for a different identity');
  }
  return record.keys;
}

/** Client-side store for this device's MLS key material, persisted in IndexedDB. */
export class DeviceKeystore {
  private constructor(
    private readonly db: IDBPDatabase,
    private readonly engine: MlsEngine,
  ) {}

  static async open(engine?: MlsEngine): Promise<DeviceKeystore> {
    // Code-enforced gate: this store is unsealed at rest (sealing lands in checkpoints 21–22), so it
    // must not run in a production build unless explicitly opted in for a dev/beta build.
    if (import.meta.env.PROD && !import.meta.env.VITE_ALLOW_UNSEALED_KEYSTORE) {
      throw new Error(
        'DeviceKeystore is unsealed at rest (encryption lands in checkpoints 21–22); refusing to ' +
          'run in a production build. Set VITE_ALLOW_UNSEALED_KEYSTORE only for dev/beta.',
      );
    }
    const db = await openDB(DB_NAME, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      },
    });
    return new DeviceKeystore(db, engine ?? (await MlsEngine.create()));
  }

  /** The persisted device, or a freshly generated + stored one (single device per user, v1). */
  async getOrCreateDevice(identity: string): Promise<DeviceKeys> {
    const existing = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (existing) return assertIdentity(existing, identity);

    // Not present: generate, then atomically put-if-still-absent in one readwrite transaction so two
    // racing first-runs (multiple tabs / a double-invoked effect) can't overwrite each other's keys.
    const fresh = await this.engine.generateDeviceKeys(identity);
    const tx = this.db.transaction(STORE, 'readwrite');
    const reread = (await tx.store.get(SELF)) as StoredDevice | undefined;
    const record: StoredDevice = reread ?? { identity, keys: fresh };
    if (!reread) await tx.store.put(record, SELF);
    await tx.done;
    return assertIdentity(record, identity);
  }

  /**
   * The persisted device keys for `identity`, or undefined if none yet. Throws if the profile holds
   * a device for a DIFFERENT identity (e.g. the browser profile is reused by another logged-in user)
   * — never hand one identity another's private keys. (Logout should clear the keystore; tracked.)
   */
  async loadDevice(identity: string): Promise<DeviceKeys | undefined> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (!stored) return undefined;
    return assertIdentity(stored, identity);
  }
}
