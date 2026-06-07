import {
  DEFAULT_ARGON2,
  MlsEngine,
  deserializeDeviceIdentity,
  deserializeDeviceKeys,
  deserializeDeviceKeysArray,
  deviceIdentity,
  deviceSignaturePublicKeyB64,
  openBackup,
  sealBackup,
  serializeDeviceIdentity,
  serializeDeviceKeys,
  serializeDeviceKeysArray,
  serializeKeyPackage,
  type Argon2Params,
  type Conversation,
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
// blob. v3 adds the one-time KeyPackage POOL store (device provisioning, Slice 2). v4 adds the sealed MLS
// GROUP-STATE store (live messaging, Slice 5). Shapes are incompatible across v1→v2: a stale v1 record
// would be misread as a sealed device and fail to unlock, so the upgrade drops the legacy store;
// v2→v3 and v3→v4 only ADD a store.
const DB_VERSION = 4;
const STORE = 'device';
const POOL_STORE = 'key-package-pool'; // sealed one-time KeyPackage pool (privates retained for join)
const GROUP_STORE = 'group-state'; // sealed MLS group state per conversation (ratchet secrets — Slice 5)
const SELF = 'self'; // single device per user in v1 (multi-device is deferred, B2)
// One-time KeyPackages kept AVAILABLE (unclaimed) in the directory so peers can claim one to add this
// device. Provisioning replenishes back to this after others claim some (see provisioning.ts).
export const POOL_TARGET = 10;

interface StoredDevice {
  identity: string;
  sealed: SealedBackup;
}

// The sealed KeyPackage pool is additionally bound to the device's SIGNATURE PUBLIC KEY — so a stale pool
// from a re-created/recovered device (same identity string, different key) is never reused (its retained
// privates would be orphaned, useless to the live key). Fail-closed against orphaned-key republishing.
interface StoredPool {
  identity: string;
  signaturePublicKey: string;
  sealed: SealedBackup;
}

// A conversation's sealed MLS group state (Slice 5). The ratchet carries live secret key material, so it's
// sealed exactly like the device/pool, and bound to the device identity + signature key so a re-created /
// recovered device (same identity string, different key) can't load a group it can't drive. Keyed by
// conversationId in the store.
interface StoredGroupState {
  identity: string;
  signaturePublicKey: string;
  conversationId: string;
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

/**
 * Thrown by importRecoveryArtifact when a device already exists for this profile — raised ONLY after the
 * artifact has been authenticated + identity-bound, so callers can safely clear + re-import on this error
 * (a typed sentinel, so the recovery layer doesn't match on brittle message text).
 */
export class DeviceExistsError extends Error {
  constructor() {
    super('keystore already holds a device; clear it before importing a backup');
    this.name = 'DeviceExistsError';
  }
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
        // v3: the sealed one-time KeyPackage pool (device provisioning). Additive — keeps the device store.
        if (!database.objectStoreNames.contains(POOL_STORE)) database.createObjectStore(POOL_STORE);
        // v4: the sealed MLS group-state store (live messaging). Additive — keyed by conversationId.
        if (!database.objectStoreNames.contains(GROUP_STORE))
          database.createObjectStore(GROUP_STORE);
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
   * Read + unseal THIS device's sealed pool record (a stale pool from a re-created/recovered device — same
   * identity string, different signature key — is discarded; its retained privates are orphaned). Returns
   * the record (to detect a concurrent write for the CAS) + the unsealed pool. The transient unsealed
   * plaintext (which holds retained HPKE privates) is wiped before returning.
   */
  private async readPool(
    identity: string,
    signaturePublicKey: string,
    passphrase: string,
  ): Promise<{ rec: StoredPool | undefined; pool: DeviceKeys[] }> {
    const rec = (await this.db.get(POOL_STORE, SELF)) as StoredPool | undefined;
    if (rec && rec.identity === identity && rec.signaturePublicKey === signaturePublicKey) {
      const opened = await openBackup(rec.sealed, passphrase);
      try {
        return { rec, pool: deserializeDeviceKeysArray(opened) };
      } finally {
        opened.fill(0); // wipe the transient unsealed plaintext (it holds retained HPKE privates)
      }
    }
    return { rec, pool: [] };
  }

  /**
   * Ensure the device's sealed one-time KeyPackage POOL holds at least `target` members, minting fresh
   * KeyPackages under the device's STABLE signature identity as needed, and return the full pool. Each
   * member's PRIVATE is retained (sealed) so the Welcome later sealed to its public KeyPackage can be
   * joined — never reuse a member across joins (forward secrecy; consumed members are removed on join).
   * The caller publishes the members' PUBLIC KeyPackages to the directory (#19). Pass the already-unlocked
   * `device` (avoids a redundant unseal); `passphrase` seals the pool under the same key as the device.
   */
  async ensurePool(
    device: DeviceKeys,
    passphrase: string,
    target: number = POOL_TARGET,
  ): Promise<DeviceKeys[]> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);

    const { rec, pool } = await this.readPool(identity, signaturePublicKey, passphrase);
    if (pool.length >= target) return pool;

    while (pool.length < target) pool.push(await this.engine.mintKeyPackage(device));
    const plaintext = serializeDeviceKeysArray(pool);
    const sealed = await sealBackup(plaintext, passphrase, this.argon);
    plaintext.fill(0); // best-effort wipe of the transient pool plaintext after sealing

    // Compare-and-swap: commit only if the store still holds exactly what we read (no racing tab wrote in
    // between). The idb tx stays atomic across get→put (no awaits between). If a racer won, ADOPT its
    // persisted pool — both tabs converge on one sealed pool whose privates are retained, so we never
    // publish KeyPackages whose private was dropped (the two-tab data-loss race).
    let won = false;
    const tx = this.db.transaction(POOL_STORE, 'readwrite');
    const current = (await tx.store.get(SELF)) as StoredPool | undefined;
    if (current?.sealed.ciphertext === rec?.sealed.ciphertext) {
      await tx.store.put({ identity, signaturePublicKey, sealed } satisfies StoredPool, SELF);
      won = true;
    }
    await tx.done;
    if (won) return pool;

    const winner = await this.readPool(identity, signaturePublicKey, passphrase); // a concurrent unlock persisted first — publish ITS retained pool
    return winner.pool.length > 0 ? winner.pool : pool;
  }

  /**
   * Remove ONE consumed member from the sealed pool — the one-time KeyPackage whose Welcome was just
   * joined. Forward secrecy: its HPKE private must never be reused or re-published, so it is dropped from
   * the pool immediately after the join is consumed. Matches on the serialized PUBLIC KeyPackage (stable
   * even though the matched member is a different object instance after any reseal/reload). Idempotent: a
   * no-op if the member is already gone. CAS-guarded like `ensurePool`, retrying on a racing writer so a
   * concurrent replenish can't resurrect the removed member.
   */
  async removePoolMember(
    device: DeviceKeys,
    passphrase: string,
    publicKeyPackageB64: string,
  ): Promise<void> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);

    for (let attempt = 0; attempt < 5; attempt++) {
      const { rec, pool } = await this.readPool(identity, signaturePublicKey, passphrase);
      const filtered = pool.filter(
        (m) => serializeKeyPackage(m.publicPackage) !== publicKeyPackageB64,
      );
      if (filtered.length === pool.length) return; // not present (or already pruned) — nothing to do

      const plaintext = serializeDeviceKeysArray(filtered);
      const sealed = await sealBackup(plaintext, passphrase, this.argon);
      plaintext.fill(0); // best-effort wipe of the transient pool plaintext after sealing

      // Compare-and-swap: commit only if the store still holds exactly what we read. On a lost CAS a racer
      // wrote (e.g. a replenish) — re-read its pool and RE-APPLY the removal, so the consumed member can
      // never survive the race (forward secrecy).
      const tx = this.db.transaction(POOL_STORE, 'readwrite');
      const current = (await tx.store.get(SELF)) as StoredPool | undefined;
      let won = false;
      if (current?.sealed.ciphertext === rec?.sealed.ciphertext) {
        await tx.store.put({ identity, signaturePublicKey, sealed } satisfies StoredPool, SELF);
        won = true;
      }
      await tx.done;
      if (won) return;
    }
    // Exhausted the CAS retries (a sustained concurrent-write storm — extraordinarily unlikely for one user
    // / a few tabs). Fail loudly so the caller surfaces a non-secret warning (id/count only, never key
    // bytes); the consumed member lingers but stays unjoinable (its Welcome is consumed) until the
    // server-side revoke (#20) + a startup reconciliation close it.
    throw new Error('could not prune the consumed KeyPackage from the pool (write contention)');
  }

  /**
   * Persist a conversation's MLS group state, SEALED (the ratchet carries live secret key material, so it is
   * sealed exactly like the device + pool). Call after any op that advanced the ratchet so a reload can
   * rehydrate the LIVE state — a stale/rolled-back save would desync the group or risk AEAD nonce reuse, so
   * the caller persists INSIDE the conversation's op mutex (see `@argus/crypto`). Bound to the device
   * identity + signature key.
   */
  async saveConversationState(
    device: DeviceKeys,
    conversationId: string,
    conversation: Conversation,
    passphrase: string,
  ): Promise<void> {
    const plaintext = await conversation.serialize();
    const sealed = await sealBackup(plaintext, passphrase, this.argon);
    plaintext.fill(0); // wipe the transient unsealed group-state bytes after sealing
    await this.db.put(
      GROUP_STORE,
      {
        identity: deviceIdentity(device),
        signaturePublicKey: deviceSignaturePublicKeyB64(device),
        conversationId,
        sealed,
      } satisfies StoredGroupState,
      conversationId,
    );
  }

  /** Rehydrate ALL of THIS device's persisted conversations (on unlock) → conversationId → Conversation. */
  async loadConversations(
    device: DeviceKeys,
    passphrase: string,
  ): Promise<Map<string, Conversation>> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);
    const recs = (await this.db.getAll(GROUP_STORE)) as StoredGroupState[];
    const out = new Map<string, Conversation>();
    for (const rec of recs) {
      // Skip a stale group from a re-created/recovered device (same identity string, different key).
      if (rec.identity !== identity || rec.signaturePublicKey !== signaturePublicKey) continue;
      // The decoded group state holds VIEWS into the unsealed bytes, so they must NOT be wiped — those bytes
      // ARE the live in-memory group state (as sensitive as the device keys, and unavoidably resident while
      // the conversation is open), not a transient copy.
      const opened = await openBackup(rec.sealed, passphrase);
      out.set(rec.conversationId, this.engine.deserializeConversation(opened));
    }
    return out;
  }

  /** Remove a conversation's persisted group state (e.g. on leave / cleanup). */
  async deleteConversationState(conversationId: string): Promise<void> {
    await this.db.delete(GROUP_STORE, conversationId);
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
      throw new DeviceExistsError();
    }
    return keys;
  }

  /**
   * Remove the stored device AND its KeyPackage pool — to recover from a bad import or reset this profile
   * before re-importing. The pool privates are tied to the cleared device's identity, so they go too.
   *
   * Local-only by design: this cannot revoke the matching PUBLIC KeyPackages already published to the
   * directory, so until they are claimed a peer could seal a Welcome to one this browser can no longer
   * open. The effect is an availability degradation only — the discarded private is unrecoverable, so no
   * Welcome sealed to it leaks (forward secrecy preserved) — and it is bounded (≤ the published pool /
   * 200-per-device cap) and self-healing (each dead package is consumed on claim). On account-switch the
   * abandoned device belongs to a DIFFERENT user, so the signed-in session has no authority to revoke it.
   * The server-side, device-scoped revoke lands with the claim/Welcome lifecycle in Slice 3 — see
   * docs/threat-models/device-provisioning.md §6.
   */
  async clearDevice(): Promise<void> {
    await this.db.delete(STORE, SELF);
    await this.db.delete(POOL_STORE, SELF);
    await this.db.clear(GROUP_STORE); // drop this profile's persisted conversations too (Slice 5)
  }

  /** Whether a sealed device is stored for this profile. Metadata only — no passphrase, no unseal. */
  async hasDevice(): Promise<boolean> {
    return (await this.db.get(STORE, SELF)) !== undefined;
  }

  /**
   * The IDENTITY of the stored device, if any — plaintext metadata (no passphrase, no unseal). Lets the
   * app detect a device belonging to a DIFFERENT signed-in account on this browser (single device slot in
   * v1): a mismatch means "switch/reset", not "wrong passphrase".
   */
  async storedIdentity(): Promise<string | undefined> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    return stored?.identity;
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
