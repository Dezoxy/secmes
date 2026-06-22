import {
  MlsEngine,
  deserializeDeviceKeys,
  deserializeDeviceKeysArray,
  deviceIdentity,
  deviceSignaturePublicKeyB64,
  openWithKey,
  sealWithKey,
  serializeDeviceKeys,
  serializeDeviceKeysArray,
  serializeKeyPackage,
  type Conversation,
  type DeviceKeys,
  type SealedBlob,
} from '@argus/crypto';
import { openDB, type IDBPDatabase } from 'idb';

import type { AttachmentRef } from './message-envelope';

// SEALED at rest: the full device key material is stored in IndexedDB only as an AES-256-GCM blob sealed
// under the per-passkey UNLOCK KEY — a WebAuthn-PRF (hmac-secret) output imported as a non-extractable
// CryptoKey (see lib/prf.ts + packages/crypto importUnlockKey). There is NO passphrase and NO Argon2: the
// PRF secret is already uniformly-random 256 bits, so it seals every store directly via sealWithKey/
// openWithKey. The SAME key seals the device, the one-time KeyPackage pool, and the per-conversation group
// state / message log / pending commit. There is NO recovery: a lost passkey (or a wiped browser keystore)
// is a fresh start — the admin mints a new registration code. See docs/threat-models/prf-keystore-unlock.md
// + device-keystore.md.

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
// v7 CUTOVER: the keystore is now sealed under a passkey-PRF-derived key (no passphrase, no Argon2). Rows
// from v1–v6 were sealed under a typed passphrase (or a passphrase-derived session key) and are unreadable
// under the new key, so the upgrade WIPES every secret-bearing store and recreates them empty. Local history
// starts fresh (a new device starts fresh anyway); the web client is unreleased, so no real user data is lost.
// v8 ADDS the verified-peers store (one row per peerUserId, keyed safety-number set sealed under the session
// key). No new wipe: v8 only creates the new store in the existing recreate loop — existing stores are
// untouched. Reinstall → no stored verified-peers → re-verify on first conversation (correct default).
const DB_VERSION = 8;
const STORE = 'device';
const POOL_STORE = 'key-package-pool'; // sealed one-time KeyPackage pool (privates retained for join)
const GROUP_STORE = 'group-state'; // sealed MLS group state per conversation (ratchet secrets — Slice 5)
const MSGLOG_STORE = 'message-log'; // sealed decrypted message history per conversation (history)
const PENDING_STORE = 'pending-commit'; // sealed pending post-commit state — written BEFORE POST, cleared on apply/discard
const VERIFIED_PEERS_STORE = 'verified-peers'; // sealed per-peer verified safety-number sets (contact-list recovery)
const SELF = 'self'; // single device per user in v1 (multi-device is deferred, B2)

// Every secret-bearing store, in the order the upgrade (re)creates them. v7 wipes + recreates all of these.
// v8 adds VERIFIED_PEERS_STORE — it is added to this list so the existing loop auto-creates it on upgrade.
const SECRET_STORES = [
  STORE,
  POOL_STORE,
  GROUP_STORE,
  MSGLOG_STORE,
  PENDING_STORE,
  VERIFIED_PEERS_STORE,
] as const;

const te = new TextEncoder();
const td = new TextDecoder();

// Domain-separation AAD for the unlock-key-sealed DEVICE and POOL blobs — distinct from the per-conversation
// AADs (groupStateAad / pendingCommitAad / the bare conversationId used by the message log), so the same
// unlock key can seal every store without a blob being replayable across slots.
const DEVICE_AAD = te.encode('device');
const POOL_AAD = te.encode('key-package-pool');

// Message-log append CAS retry bound. Each round exactly one racer commits (its version advances), so N
// concurrent appenders converge in ≤ N rounds — a single user's handful of tabs is far under this. The cap
// only guards a pathological hot-loop; exhausting it throws (surfaced) rather than silently dropping entries.
const MAX_APPEND_CAS_RETRIES = 50;
// One-time KeyPackages kept AVAILABLE (unclaimed) in the directory so peers can claim one to add this
// device. Provisioning replenishes back to this after others claim some (see provisioning.ts).
export const POOL_TARGET = 10;

interface StoredDevice {
  identity: string;
  sealed: SealedBlob;
}

// The sealed KeyPackage pool is additionally bound to the device's SIGNATURE PUBLIC KEY — so a stale pool
// from a re-created device (same identity string, different key) is never reused (its retained privates would
// be orphaned, useless to the live key). Fail-closed against orphaned-key republishing.
interface StoredPool {
  identity: string;
  signaturePublicKey: string;
  sealed: SealedBlob;
}

// A conversation's sealed MLS group state (Slice 5). The ratchet carries live secret key material; it's
// bound to the device identity + signature key so a re-created / recovered device (same identity string,
// different key) can't load a group it can't drive. Keyed by conversationId in the store.
//
// SEALING: sealed under the per-unlock UNLOCK KEY (cheap AES-GCM, like the message log) — the state advances
// on EVERY send/receive, so a per-save KDF would make each delivered message cost seconds.
interface StoredGroupState {
  identity: string;
  signaturePublicKey: string;
  conversationId: string;
  sealed: SealedBlob;
  // Monotonic per-conversation version for the cross-instance CAS (see saveConversationState). Bumped on
  // every successful save; a write is only committed if the store still holds the version the writer last saw.
  version: number;
  /** The userId of the member who created this group — persisted by the creator only. Used to gate
   * "Add member" so the button survives page reload (in-memory creatorId is lost on unmount). */
  creatorId?: string;
  /** Track 4 slice 5c — set once the conversation is detected "sync-lost" (its MLS epoch can no longer
   * advance; the commit it needs was pruned). Durable so the "out of sync" affordance survives a reload
   * and the stale group is not silently rehydrated as live (a stale-epoch send would be undecryptable).
   * Monotonic in v1 (only set, never cleared) — clearing on a successful re-join is slice 5c-2. */
  syncLost?: boolean;
}

/** One decrypted message in the local history log — PLAINTEXT, only ever stored SEALED (see StoredMessageLog). */
export interface StoredMessage {
  id: string; // the server message id (or local echo id) — dedup key
  senderId: string;
  content: string; // plaintext message text
  timestamp: string; // ISO 8601
  status: string; // 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  encrypted?: boolean;
  /** 'group-meta' for in-stream group-name updates — filtered from the transcript but persisted so the
   * group name survives page reload (extracted during history rehydration). Absent for chat messages. */
  kind?: 'group-meta';
  // E2E attachment refs (objectKey + content key/iv). Sealed at rest with the rest of the log, like `content`.
  attachments?: AttachmentRef[];
}

// A conversation's local message history, SEALED at rest under the per-unlock SESSION KEY (cheap AES-GCM,
// no per-message Argon2). Bound to the device identity + signature key like the group state. The `sealed`
// blob holds the JSON-encoded StoredMessage[]; the session key is never persisted (memory only). Keyed by
// conversationId in the store.
interface StoredMessageLog {
  identity: string;
  signaturePublicKey: string;
  conversationId: string;
  sealed: SealedBlob;
  // Monotonic version for the cross-tab compare-and-swap (see appendMessagesUnlocked). A lost CAS means
  // another tab appended concurrently — re-read + re-merge + retry, so neither tab's entries are dropped.
  version: number;
}

/**
 * AAD for a session-key-sealed GROUP-STATE blob: pins it to its conversation slot AND domain-separates it
 * from the message log (which binds the bare conversationId) — the same session key seals both stores, so
 * without the prefix a log blob could be replayed into the group-state slot (and vice versa).
 */
function groupStateAad(conversationId: string): Uint8Array {
  return te.encode(`group-state:${conversationId}`);
}

/** AAD for a pending-commit blob — domain-separates from group-state and message-log blobs. */
function pendingCommitAad(conversationId: string): Uint8Array {
  return te.encode(`pending-commit:${conversationId}`);
}

/** AAD for a verified-peers blob — pins it to the peerUserId slot and domain-separates from all other stores. */
function verifiedPeersAad(peerUserId: string): Uint8Array {
  return te.encode(`verified-peers:${peerUserId}`);
}

// One row in the verified-peers store (key = peerUserId). Holds the sorted, deduped set of per-device
// safety numbers verified by the user for this peer's currently-present MLS devices. Sealed under the
// per-session PRF key — the `peerUserId → numbers` association is social-graph metadata, never plain-text.
interface StoredVerifiedPeer {
  peerUserId: string;
  sealed: SealedBlob;
}

// A pending post-commit state persisted BEFORE the POST, so a crash between a successful POST and
// applyStaged/saveConversationState doesn't desync the device (the device reloads at the old epoch
// while the server/peers are already at the new epoch). On reload, loadConversations promotes the
// pending state to the live group-state slot and clears this entry.
interface StoredPendingCommit {
  identity: string;
  signaturePublicKey: string;
  conversationId: string;
  /** The pre-commit epoch (staged.epoch) used to verify the commit landed on the server. */
  epoch: number;
  /** The UUID sent to the server as clientCommitId — used to verify it was OUR commit that won. */
  clientCommitId: string;
  sealed: SealedBlob;
}

/**
 * Thrown by saveConversationState when the persisted group state moved on under this instance — another tab
 * or a second unlock rehydrated its own Conversation and saved a newer state. A typed sentinel so the (5B)
 * send path can react (treat this instance as stale: stop sending, rehydrate) instead of letting a stale
 * write roll the durable ratchet back. The persisted state is NOT overwritten when this is thrown.
 */
export class GroupStateConflict extends Error {
  constructor(public readonly conversationId: string) {
    super('group state changed under this instance (another tab or unlock); reload to continue');
    this.name = 'GroupStateConflict';
  }
}

/** Client-side store for this device's MLS key material — sealed at rest under the passkey-PRF unlock key. */
export class DeviceKeystore {
  // Per-conversation version this instance last persisted — the CAS base for cross-instance save ordering.
  // Diverges from the store the moment another tab / unlock saves, so a stale write is caught (see
  // saveConversationState). Map ref is fixed; contents mutate.
  private readonly groupStateVersions = new Map<string, number>();
  // Per-conversation append serializer for the message log — its read-modify-write (open → merge → seal →
  // put) isn't atomic across awaits, so concurrent appends (a WS push during a backfill) chain instead of
  // racing (a lost update would drop a message from history permanently).
  private readonly appendChains = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly db: IDBPDatabase,
    private readonly engine: MlsEngine,
  ) {}

  static async open(engine?: MlsEngine): Promise<DeviceKeystore> {
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 7) {
          // v7 cutover: every store from v1–v6 was sealed under a typed passphrase or a passphrase-derived
          // session key, all unreadable under the new passkey-PRF unlock key. Wipe every store (including the
          // obsolete `meta` store that held the old session-key salt) and recreate only the PRF-sealed set.
          // Nothing in the dropped stores can be unsealed; a fresh device is minted on the next
          // getOrCreateDevice. Best-effort at-rest clearing — the browser decides when backing pages are reclaimed.
          for (const name of Array.from(database.objectStoreNames)) {
            database.deleteObjectStore(name);
          }
        }
        // v8+ additive: create any store that does not exist yet (idempotent for future upgrades).
        // For a v7→v8 upgrade only VERIFIED_PEERS_STORE is missing; all other stores are left intact.
        for (const name of SECRET_STORES) {
          if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
        }
      },
    });
    return new DeviceKeystore(db, engine ?? (await MlsEngine.create()));
  }

  /**
   * The persisted device (opened with the PRF `unlockKey`), or a freshly generated one — sealed + stored.
   * Single device per user; throws if the profile holds a device for a different identity, or if the unlock
   * key is wrong (open fails — GCM auth).
   */
  async getOrCreateDevice(identity: string, unlockKey: CryptoKey): Promise<DeviceKeys> {
    const existing = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (existing) return this.unseal(existing, identity, unlockKey);

    const keys = await this.engine.generateDeviceKeys(identity);
    const plaintext = serializeDeviceKeys(keys);
    const sealed = await sealWithKey(unlockKey, plaintext, DEVICE_AAD);
    plaintext.fill(0); // best-effort wipe of the transient device plaintext after sealing

    // Atomic put-if-absent: a racing first-run can't overwrite an already-sealed device.
    const tx = this.db.transaction(STORE, 'readwrite');
    const reread = (await tx.store.get(SELF)) as StoredDevice | undefined;
    if (!reread) await tx.store.put({ identity, sealed } satisfies StoredDevice, SELF);
    await tx.done;
    return reread ? this.unseal(reread, identity, unlockKey) : keys;
  }

  /** The persisted device keys for `identity`, opened with the PRF `unlockKey`; undefined if none yet. */
  async loadDevice(identity: string, unlockKey: CryptoKey): Promise<DeviceKeys | undefined> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (!stored) return undefined;
    return this.unseal(stored, identity, unlockKey);
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
    unlockKey: CryptoKey,
  ): Promise<{ rec: StoredPool | undefined; pool: DeviceKeys[] }> {
    const rec = (await this.db.get(POOL_STORE, SELF)) as StoredPool | undefined;
    if (rec && rec.identity === identity && rec.signaturePublicKey === signaturePublicKey) {
      const opened = await openWithKey(unlockKey, rec.sealed, POOL_AAD);
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
   * `device` (avoids a redundant unseal); `unlockKey` seals the pool under the same key as the device.
   */
  async ensurePool(
    device: DeviceKeys,
    unlockKey: CryptoKey,
    target: number = POOL_TARGET,
  ): Promise<DeviceKeys[]> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);

    const { rec, pool } = await this.readPool(identity, signaturePublicKey, unlockKey);
    if (pool.length >= target) return pool;

    while (pool.length < target) pool.push(await this.engine.mintKeyPackage(device));
    const plaintext = serializeDeviceKeysArray(pool);
    const sealed = await sealWithKey(unlockKey, plaintext, POOL_AAD);
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

    const winner = await this.readPool(identity, signaturePublicKey, unlockKey); // a concurrent unlock persisted first — publish ITS retained pool
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
    unlockKey: CryptoKey,
    publicKeyPackageB64: string,
  ): Promise<void> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);

    for (let attempt = 0; attempt < 5; attempt++) {
      const { rec, pool } = await this.readPool(identity, signaturePublicKey, unlockKey);
      const filtered = pool.filter(
        (m) => serializeKeyPackage(m.publicPackage) !== publicKeyPackageB64,
      );
      if (filtered.length === pool.length) return; // not present (or already pruned) — nothing to do

      const plaintext = serializeDeviceKeysArray(filtered);
      const sealed = await sealWithKey(unlockKey, plaintext, POOL_AAD);
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
   * rehydrate the LIVE state. Two layers keep a stale state from overwriting a newer one (which would desync
   * the group or risk AEAD nonce reuse):
   *
   * 1. **Within one instance:** the snapshot AND its seal + write run INSIDE the conversation's op mutex via
   *    `persistVia`, so concurrent saves on the same `Conversation` can't reorder.
   * 2. **Across instances** (two tabs / a double-unlock — each rehydrates its OWN `Conversation` with an
   *    independent op queue, so layer 1 can't order them): a monotonic `version` + compare-and-swap. The
   *    write commits only if the store still holds the version THIS instance last saw; otherwise a newer
   *    instance got there first and we throw `GroupStateConflict` instead of rolling the durable ratchet
   *    back. The single readwrite tx makes get→check→put atomic (IndexedDB serializes it against the other
   *    tab's tx); the (async, non-IDB) seal runs BEFORE the tx so nothing non-IDB is awaited mid-transaction.
   *
   * Bound to the device identity + signature key. (CAS keeps the *durable* state monotonic; it does not gate
   * two tabs *sending* concurrently — that needs single-writer send coordination, wired with the send path.)
   */
  /**
   * Build a persister function for a conversation that seals + CAS-writes a raw snapshot.
   * The returned function runs OUTSIDE the conversation's op queue — pass it directly to
   * `conversation.processCommit(wire, persister)`, which calls it from WITHIN its own `run()`.
   * (Calling `saveConversationState` from there would re-enter `run()` and deadlock.)
   */
  makeConversationPersister(
    device: DeviceKeys,
    conversationId: string,
    sessionKey: CryptoKey,
  ): (snapshot: Uint8Array) => Promise<void> {
    return async (snapshot) => {
      const sealed = await sealWithKey(sessionKey, snapshot, groupStateAad(conversationId));
      snapshot.fill(0);
      const base = this.groupStateVersions.get(conversationId) ?? -1;
      const tx = this.db.transaction(GROUP_STORE, 'readwrite');
      const current = (await tx.store.get(conversationId)) as StoredGroupState | undefined;
      const conflict = (current?.version ?? -1) !== base;
      const version = base + 1;
      if (!conflict) {
        await tx.store.put(
          {
            identity: deviceIdentity(device),
            signaturePublicKey: deviceSignaturePublicKeyB64(device),
            conversationId,
            sealed,
            version,
            // Preserve creatorId across ratchet saves (set once by confirmCreate; never cleared here).
            ...(current?.creatorId !== undefined ? { creatorId: current.creatorId } : {}),
            // Preserve the sync-lost marker across any in-flight ratchet save (5c) — same idiom as
            // creatorId, so a save that races detection can never silently drop the durable flag.
            ...(current?.syncLost ? { syncLost: true } : {}),
          } satisfies StoredGroupState,
          conversationId,
        );
      }
      await tx.done;
      if (conflict) throw new GroupStateConflict(conversationId);
      this.groupStateVersions.set(conversationId, version);
    };
  }

  async saveConversationState(
    device: DeviceKeys,
    conversationId: string,
    conversation: Conversation,
    sessionKey: CryptoKey,
  ): Promise<void> {
    await conversation.persistVia(
      this.makeConversationPersister(device, conversationId, sessionKey),
    );
  }

  /**
   * Record that this device's user is the creator of `conversationId`. Called once by
   * `GroupConversationManager.confirmCreate` so the "Add member" gate survives page reload.
   * No-op if the group-state record doesn't exist yet (the caller must ensure the conversation
   * has been persisted first — `saveConversationState` is idempotent, so call order is safe).
   */
  async saveGroupCreatorId(
    device: DeviceKeys,
    conversationId: string,
    creatorId: string,
  ): Promise<void> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);
    const rec = (await this.db.get(GROUP_STORE, conversationId)) as StoredGroupState | undefined;
    if (!rec || rec.identity !== identity || rec.signaturePublicKey !== signaturePublicKey) return;
    await this.db.put(GROUP_STORE, { ...rec, creatorId }, conversationId);
  }

  /**
   * Return a `conversationId → creatorId` map for all conversations on this device where the
   * creator was recorded (only conversations created — not joined — by this device have an entry).
   */
  async getGroupCreatorIds(device: DeviceKeys): Promise<Map<string, string>> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);
    const recs = (await this.db.getAll(GROUP_STORE)) as StoredGroupState[];
    const out = new Map<string, string>();
    for (const rec of recs) {
      if (rec.identity !== identity || rec.signaturePublicKey !== signaturePublicKey) continue;
      if (rec.creatorId) out.set(rec.conversationId, rec.creatorId);
    }
    return out;
  }

  /**
   * Track 4 slice 5c — durably mark `conversationId` as "sync-lost" (its MLS epoch can no longer
   * advance). Idempotent, monotonic, device-scoped. No-op if the record is absent or bound to a
   * different device.
   *
   * The read-modify-write runs INSIDE a single `readwrite` transaction (NOT the separate get/put of
   * `saveGroupCreatorId`): unlike creatorId — set once at creation when nothing else writes — this is
   * called at sync-lost DETECTION time, which races in-flight / cross-tab ratchet saves. A separate
   * get-then-put could read the row, have a `saveConversationState` commit a newer `sealed`/`version`
   * in between, then write the STALE record back just to add the flag — a ratchet rollback. IndexedDB
   * serializes transactions on a store, so reading + writing within one tx flips the flag on the LATEST
   * row, preserving its sealed state and version (which the persister then carries forward).
   */
  async markConversationSyncLost(device: DeviceKeys, conversationId: string): Promise<void> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);
    const tx = this.db.transaction(GROUP_STORE, 'readwrite');
    const rec = (await tx.store.get(conversationId)) as StoredGroupState | undefined;
    if (
      rec &&
      rec.identity === identity &&
      rec.signaturePublicKey === signaturePublicKey &&
      !rec.syncLost // already marked — skip the redundant write
    ) {
      // Keep the freshly-read sealed state + version; only add the flag. Same version, so the
      // persister's in-memory CAS base stays valid (no false GroupStateConflict on the next save).
      await tx.store.put({ ...rec, syncLost: true }, conversationId);
    }
    await tx.done;
  }

  /**
   * Track 4 slice 5c — the set of THIS device's conversations durably marked sync-lost. Read at
   * rehydration so the "out of sync" affordance survives a reload and the stale group is not rehydrated
   * as live (mirrors `getGroupCreatorIds`).
   */
  async getSyncLostConversationIds(device: DeviceKeys): Promise<Set<string>> {
    const identity = deviceIdentity(device);
    const signaturePublicKey = deviceSignaturePublicKeyB64(device);
    const recs = (await this.db.getAll(GROUP_STORE)) as StoredGroupState[];
    const out = new Set<string>();
    for (const rec of recs) {
      if (rec.identity !== identity || rec.signaturePublicKey !== signaturePublicKey) continue;
      if (rec.syncLost) out.add(rec.conversationId);
    }
    return out;
  }

  /** Rehydrate ALL of THIS device's persisted conversations (on unlock) → conversationId → Conversation. */
  async loadConversations(
    device: DeviceKeys,
    sessionKey: CryptoKey,
    /**
     * Optional server verifier for orphaned pending-commit recovery (brand-new group crash window).
     * Called before promoting a PENDING_STORE entry that has no matching GROUP_STORE record.
     * Returns true if the commit landed on the server (i.e., the epoch slot exists); false to discard.
     * Omit in tests — orphaned entries are promoted unconditionally.
     */
    verifyCommitExists?: (
      conversationId: string,
      epoch: number,
      clientCommitId: string,
    ) => Promise<boolean>,
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
      const opened = await openWithKey(sessionKey, rec.sealed, groupStateAad(rec.conversationId));

      // Crash recovery: if a pending-commit slot exists, a prior session staged a commit and POSTed
      // it successfully but crashed before applyStaged/saveConversationState ran. `serializeStaged`
      // produces the POST-COMMIT state (epoch N+1), so promoting it is the only way to recover the
      // committed ratchet — the sender cannot re-apply their own commit wire via processCommit.
      // If the POST failed (ambiguous network error), the pending state is epoch N+1 while the server
      // is still at epoch N; promoting would strand the device at a phantom epoch. `verifyCommitExists`
      // (passed by the production caller) guards against this by confirming the slot exists on the server.
      const pendingRec = (await this.db.get(PENDING_STORE, rec.conversationId)) as
        | StoredPendingCommit
        | undefined;
      if (
        pendingRec &&
        pendingRec.identity === identity &&
        pendingRec.signaturePublicKey === signaturePublicKey
      ) {
        // Verify our commit (not another member's) actually landed on the server before promoting.
        const commitLanded =
          !verifyCommitExists ||
          (await verifyCommitExists(
            rec.conversationId,
            pendingRec.epoch,
            pendingRec.clientCommitId,
          ));
        if (!commitLanded) {
          // POST failed before reaching the server — discard pending slot, load pre-commit state.
          await this.db.delete(PENDING_STORE, rec.conversationId);
          out.set(rec.conversationId, this.engine.deserializeConversation(opened));
          this.groupStateVersions.set(rec.conversationId, rec.version ?? -1);
          continue;
        }
        // CAS base must be set BEFORE saveConversationState so its persister sees the right version.
        this.groupStateVersions.set(rec.conversationId, rec.version ?? -1);
        try {
          const pendingBytes = await openWithKey(
            sessionKey,
            pendingRec.sealed,
            pendingCommitAad(rec.conversationId),
          );
          const advanced = this.engine.deserializeConversation(pendingBytes);
          await this.saveConversationState(device, rec.conversationId, advanced, sessionKey);
          await this.db.delete(PENDING_STORE, rec.conversationId);
          out.set(rec.conversationId, advanced);
        } catch {
          // Pending state corrupt or wrong key — fall back; the drain path re-syncs from the server.
          await this.db.delete(PENDING_STORE, rec.conversationId);
          out.set(rec.conversationId, this.engine.deserializeConversation(opened));
        }
      } else {
        out.set(rec.conversationId, this.engine.deserializeConversation(opened));
        // Record the loaded version as this instance's CAS base; a later save by another tab bumps the
        // store past it and is caught (see saveConversationState).
        this.groupStateVersions.set(rec.conversationId, rec.version ?? -1);
      }
    }

    // Orphaned-pending scan: when a new-group create crashes between saveStagedCommit (PENDING_STORE
    // written) and the first saveConversationState (GROUP_STORE never written), the GROUP_STORE loop
    // above never visits the PENDING_STORE entry. Scan all pending entries and promote any whose
    // conversationId is NOT already in `out` — bootstrapping the GROUP_STORE record from the sealed
    // post-commit state so the creator recovers the group on reload.
    const allPending = (await this.db.getAll(PENDING_STORE)) as StoredPendingCommit[];
    for (const pendingRec of allPending) {
      if (pendingRec.identity !== identity || pendingRec.signaturePublicKey !== signaturePublicKey)
        continue;
      const { conversationId } = pendingRec;
      if (out.has(conversationId)) continue; // already handled by the GROUP_STORE loop
      // Before promoting, verify the commit actually landed on the server. If the POST failed
      // (network drop before the request left the browser), the pending state is epoch N+1 while
      // the server is still at epoch N; promoting it would strand this device at a phantom epoch
      // where messages are stored but undecryptable by peers. Skip the entry if unconfirmed.
      if (
        verifyCommitExists &&
        !(await verifyCommitExists(conversationId, pendingRec.epoch, pendingRec.clientCommitId))
      ) {
        await this.db.delete(PENDING_STORE, conversationId);
        continue;
      }
      try {
        const pendingBytes = await openWithKey(
          sessionKey,
          pendingRec.sealed,
          pendingCommitAad(conversationId),
        );
        const conversation = this.engine.deserializeConversation(pendingBytes);
        this.groupStateVersions.set(conversationId, -1); // no prior GROUP_STORE record
        await this.saveConversationState(device, conversationId, conversation, sessionKey);
        await this.db.delete(PENDING_STORE, conversationId);
        out.set(conversationId, conversation);
      } catch {
        // Pending bytes corrupt or wrong key — discard; the creator will need a re-invite.
        await this.db.delete(PENDING_STORE, conversationId);
      }
    }

    return out;
  }

  /**
   * Whether THIS device already has persisted group state for a conversation — metadata only, no unseal, no
   * passphrase. Lets the join drain detect an already-recovered conversation and NOT overwrite its advanced
   * ratchet with a replayed Welcome's fresh post-join state (which would roll the group back).
   */
  async hasConversationState(device: DeviceKeys, conversationId: string): Promise<boolean> {
    const rec = (await this.db.get(GROUP_STORE, conversationId)) as StoredGroupState | undefined;
    return (
      !!rec &&
      rec.identity === deviceIdentity(device) &&
      rec.signaturePublicKey === deviceSignaturePublicKeyB64(device)
    );
  }

  /** Remove a conversation's persisted group state (e.g. on leave / cleanup). */
  async deleteConversationState(conversationId: string): Promise<void> {
    await this.db.delete(GROUP_STORE, conversationId);
    this.groupStateVersions.delete(conversationId);
  }

  /**
   * Persist the PENDING post-commit state (from `conversation.serializeStaged(staged)`) to the
   * pending-commit slot, sealed under the session key. Must be called BEFORE POSTing the commit
   * to the server so a crash between a successful POST and `applyStaged`/`saveConversationState`
   * doesn't strand the device at the old epoch while peers are at the new one.
   */
  async saveStagedCommit(
    device: DeviceKeys,
    conversationId: string,
    sessionKey: CryptoKey,
    pendingBytes: Uint8Array,
    /** The pre-commit epoch (staged.epoch) — used on reload to verify the commit landed. */
    epoch: number,
    /** The clientCommitId sent to the server — used to verify OUR commit won (not another member's). */
    clientCommitId: string,
  ): Promise<void> {
    const sealed = await sealWithKey(sessionKey, pendingBytes, pendingCommitAad(conversationId));
    await this.db.put(
      PENDING_STORE,
      {
        identity: deviceIdentity(device),
        signaturePublicKey: deviceSignaturePublicKeyB64(device),
        conversationId,
        epoch,
        clientCommitId,
        sealed,
      } satisfies StoredPendingCommit,
      conversationId,
    );
  }

  /** Remove the pending-commit slot after a successful `applyStaged`/`saveConversationState`. */
  async clearStagedCommit(conversationId: string): Promise<void> {
    await this.db.delete(PENDING_STORE, conversationId);
  }

  // ---- Message history (local, sealed under the per-unlock PRF unlock key) --------------------------------
  // The "session key" threaded through the message-log + group-state APIs IS the passkey-PRF unlock key (the
  // same non-extractable AES-256-GCM CryptoKey that seals the device + pool). There is no separate derivation:
  // the PRF secret is already uniformly random, so it seals everything directly. Held in memory only for the
  // session. Nonce budget: sealWithKey uses a fresh CSPRNG 96-bit IV per seal; random-IV AES-GCM is safe to
  // ~2^32 seals per key (NIST SP 800-38D), far above any session's seal count even with per-message sealing.

  /** Open + decode a message-log record, or [] if it isn't this device's or the key/blob doesn't verify. */
  private async openLog(
    rec: StoredMessageLog | undefined,
    device: DeviceKeys,
    sessionKey: CryptoKey,
  ): Promise<StoredMessage[]> {
    if (
      !rec ||
      rec.identity !== deviceIdentity(device) ||
      rec.signaturePublicKey !== deviceSignaturePublicKeyB64(device)
    ) {
      return [];
    }
    try {
      // The conversationId is bound into the seal's AAD — a blob relocated to another slot won't open.
      const bytes = await openWithKey(sessionKey, rec.sealed, te.encode(rec.conversationId));
      return JSON.parse(td.decode(bytes)) as StoredMessage[];
    } catch {
      // Wrong key (a different unlock key) or tampered/relocated blob — treat as no history; never throw to UI.
      return [];
    }
  }

  /** A conversation's decrypted history (oldest-first), or [] if none / not this device. */
  async loadMessageLog(
    device: DeviceKeys,
    conversationId: string,
    sessionKey: CryptoKey,
  ): Promise<StoredMessage[]> {
    const rec = (await this.db.get(MSGLOG_STORE, conversationId)) as StoredMessageLog | undefined;
    return this.openLog(rec, device, sessionKey);
  }

  /** ALL of this device's persisted histories (on unlock) → conversationId → messages. */
  async loadAllMessageLogs(
    device: DeviceKeys,
    sessionKey: CryptoKey,
  ): Promise<Map<string, StoredMessage[]>> {
    const recs = (await this.db.getAll(MSGLOG_STORE)) as StoredMessageLog[];
    const out = new Map<string, StoredMessage[]>();
    for (const rec of recs) {
      const msgs = await this.openLog(rec, device, sessionKey);
      if (msgs.length > 0) out.set(rec.conversationId, msgs);
    }
    return out;
  }

  /**
   * Append messages to a conversation's sealed history (upsert by id — a later status update replaces the
   * prior entry), then re-seal the whole log. Serialized per conversation so a concurrent append (a WS push
   * during a backfill) can't lose an update. PLAINTEXT in → sealed at rest under the session key.
   */
  async appendMessages(
    device: DeviceKeys,
    conversationId: string,
    sessionKey: CryptoKey,
    entries: StoredMessage[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const prev = this.appendChains.get(conversationId) ?? Promise.resolve();
    const run = prev.then(() =>
      this.appendMessagesUnlocked(device, conversationId, sessionKey, entries),
    );
    this.appendChains.set(
      conversationId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendMessagesUnlocked(
    device: DeviceKeys,
    conversationId: string,
    sessionKey: CryptoKey,
    entries: StoredMessage[],
  ): Promise<void> {
    // Cross-tab safe via a version CAS: the in-memory `appendChains` only orders appends within THIS tab, so
    // two tabs could each read the same log, merge different entries, and the later put would clobber the
    // earlier (a history entry lost). Instead: read the current (version, log), merge OUR entries, then
    // commit only if the stored version is unchanged. On a lost CAS another tab appended — re-read its newer
    // log, RE-MERGE our entries into it, and retry, so neither tab's entries are dropped.
    for (let attempt = 0; attempt < MAX_APPEND_CAS_RETRIES; attempt += 1) {
      const rec = (await this.db.get(MSGLOG_STORE, conversationId)) as StoredMessageLog | undefined;
      const base = rec?.version ?? -1;
      const existing = await this.openLog(rec, device, sessionKey); // [] if none / not this device
      const byId = new Map(existing.map((m) => [m.id, m]));
      for (const e of entries) byId.set(e.id, e); // upsert: latest status/content for an id wins
      const merged = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      // Bind the conversationId into the AAD so this blob is pinned to its slot (see openLog).
      const sealed = await sealWithKey(
        sessionKey,
        te.encode(JSON.stringify(merged)),
        te.encode(conversationId),
      );

      // The seal (async, non-IDB) ran OUTSIDE the tx; the get→check→put below is the atomic CAS.
      const tx = this.db.transaction(MSGLOG_STORE, 'readwrite');
      const current = (await tx.store.get(conversationId)) as StoredMessageLog | undefined;
      if ((current?.version ?? -1) === base) {
        await tx.store.put(
          {
            identity: deviceIdentity(device),
            signaturePublicKey: deviceSignaturePublicKeyB64(device),
            conversationId,
            sealed,
            version: base + 1,
          } satisfies StoredMessageLog,
          conversationId,
        );
        await tx.done;
        return;
      }
      await tx.done; // lost the CAS — another tab appended; re-read + re-merge + retry
    }
    // Each round one writer commits, so reaching here means sustained pathological contention. Surface a
    // REAL failure (the caller logs it; the entries are still in the UI, just not yet persisted) rather than
    // silently returning as if the append succeeded — which would drop locally-decrypted history.
    throw new Error('could not persist message history after sustained write contention');
  }

  /** Remove a conversation's persisted history (e.g. on leave / clear-history). */
  async deleteMessageLog(conversationId: string): Promise<void> {
    await this.db.delete(MSGLOG_STORE, conversationId);
    this.appendChains.delete(conversationId);
  }

  /**
   * Remove the stored device AND its KeyPackage pool — to reset this profile (e.g. clear a different
   * account's device occupying the single slot). The pool privates are tied to the cleared device's
   * identity, so they go too.
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
    await this.db.clear(MSGLOG_STORE); // drop this profile's message history (history feature)
    await this.db.clear(PENDING_STORE); // drop any pending-commit slots
    await this.db.clear(VERIFIED_PEERS_STORE); // drop verified-peer trust records
    this.groupStateVersions.clear();
    this.appendChains.clear();
  }

  /**
   * Clear the device credential while preserving GROUP_STORE and MSGLOG_STORE.
   * Only the STORE (sealed device), POOL_STORE (one-time key packages), and PENDING_STORE
   * (pending commits) are removed. Use reidentifyDevice + clearPoolAndPending + rebindGroupStates
   * + rebindMessageLogs to migrate the identity string without regenerating the signing key.
   */
  async clearDeviceOnly(): Promise<void> {
    await this.db.delete(STORE, SELF);
    await this.db.delete(POOL_STORE, SELF);
    await this.db.clear(PENDING_STORE);
    // GROUP_STORE and MSGLOG_STORE are intentionally preserved.
  }

  /**
   * Clear only the one-time KeyPackage pool and any pending-commit slots (stale after a device
   * withdraw + server-side re-provision). The device credential, group states, and message logs are
   * left intact. Call after reidentifyDevice to discard the old pool whose HPKE privates belong to the
   * pre-migration server device row.
   */
  async clearPoolAndPending(): Promise<void> {
    await this.db.delete(POOL_STORE, SELF);
    await this.db.clear(PENDING_STORE);
  }

  /**
   * Reidentify the stored device: open it under `oldIdentity`, recreate it with the SAME Ed25519
   * signing key under `newIdentity` (via engine.exportIdentity + engine.deviceFromIdentity), reseal
   * under the PRF `unlockKey`, and write back to STORE. Preserves the signing key so existing MLS group
   * states (whose serialized ratchet embeds the private key) remain usable; only the identity string
   * metadata guard changes. Call clearPoolAndPending() + rebindGroupStates() + rebindMessageLogs()
   * afterwards to bring all metadata guards up to date.
   */
  async reidentifyDevice(
    oldIdentity: string,
    newIdentity: string,
    unlockKey: CryptoKey,
  ): Promise<DeviceKeys> {
    const stored = (await this.db.get(STORE, SELF)) as StoredDevice | undefined;
    if (!stored) throw new Error('no device to reidentify');
    const oldDev = await this.unseal(stored, oldIdentity, unlockKey);
    const idMat = this.engine.exportIdentity(oldDev);
    const newDev = await this.engine.deviceFromIdentity({ ...idMat, identity: newIdentity });
    const plaintext = serializeDeviceKeys(newDev);
    const sealed = await sealWithKey(unlockKey, plaintext, DEVICE_AAD);
    plaintext.fill(0);
    await this.db.put(STORE, { identity: newIdentity, sealed } satisfies StoredDevice, SELF);
    return newDev;
  }

  /**
   * Rebind all GROUP_STORE records to a new device's identity and signature public key. Safe
   * because the sealed group-state blobs contain the signing private key internally (via
   * engine.deserializeConversation), so the metadata guard is the only thing that changes —
   * the ratchet and leaf-node key are unaffected. Call after reidentifyDevice so loadConversations
   * can find and load the preserved group states.
   */
  async rebindGroupStates(newDevice: DeviceKeys): Promise<void> {
    const newIdentity = deviceIdentity(newDevice);
    const newSpk = deviceSignaturePublicKeyB64(newDevice);
    const recs = (await this.db.getAll(GROUP_STORE)) as StoredGroupState[];
    if (recs.length === 0) return;
    const tx = this.db.transaction(GROUP_STORE, 'readwrite');
    for (const rec of recs) {
      if (rec.identity !== newIdentity || rec.signaturePublicKey !== newSpk) {
        await tx.store.put(
          { ...rec, identity: newIdentity, signaturePublicKey: newSpk },
          rec.conversationId,
        );
      }
    }
    await tx.done;
  }

  /**
   * Rebind all MSGLOG_STORE records to a new device's identity and signature public key. Safe
   * because the sealed blobs use only the conversationId as AAD — the device identity is a
   * metadata guard only, not part of the crypto. Call after reidentifyDevice so openLog() can
   * find and return historical messages.
   */
  async rebindMessageLogs(newDevice: DeviceKeys): Promise<void> {
    const newIdentity = deviceIdentity(newDevice);
    const newSpk = deviceSignaturePublicKeyB64(newDevice);
    const recs = (await this.db.getAll(MSGLOG_STORE)) as StoredMessageLog[];
    if (recs.length === 0) return;
    const tx = this.db.transaction(MSGLOG_STORE, 'readwrite');
    for (const rec of recs) {
      if (rec.identity !== newIdentity || rec.signaturePublicKey !== newSpk) {
        await tx.store.put(
          { ...rec, identity: newIdentity, signaturePublicKey: newSpk },
          rec.conversationId,
        );
      }
    }
    await tx.done;
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

  /**
   * Load the verified safety-number set for a peer, or `null` if the peer has never been verified on
   * this device (including after a reinstall that wiped the store). Returns `null` — not `[]` — on a
   * missing record so callers can distinguish "never verified" from "verified but tampered/wrong key".
   * Errors (wrong session key, tampered blob) return `null` silently — fail-safe toward re-verify.
   */
  async loadVerifiedPeer(peerUserId: string, sessionKey: CryptoKey): Promise<string[] | null> {
    const rec = (await this.db.get(VERIFIED_PEERS_STORE, peerUserId)) as
      | StoredVerifiedPeer
      | undefined;
    if (!rec) return null;
    try {
      const bytes = await openWithKey(sessionKey, rec.sealed, verifiedPeersAad(peerUserId));
      return JSON.parse(td.decode(bytes)) as string[];
    } catch {
      return null;
    }
  }

  /**
   * Persist the verified safety-number set for a peer. `sortedNumbers` must be sorted and deduped
   * (callers are responsible — the load path does no normalization). Overwrites any prior record for
   * this peerUserId. Called when the user explicitly marks a peer verified via the VerifySecurity panel,
   * and when a rejoined conversation's number set matches the previously stored set.
   */
  async saveVerifiedPeer(
    peerUserId: string,
    sortedNumbers: string[],
    sessionKey: CryptoKey,
  ): Promise<void> {
    const sealed = await sealWithKey(
      sessionKey,
      te.encode(JSON.stringify(sortedNumbers)),
      verifiedPeersAad(peerUserId),
    );
    await this.db.put(
      VERIFIED_PEERS_STORE,
      { peerUserId, sealed } satisfies StoredVerifiedPeer,
      peerUserId,
    );
  }

  async deleteVerifiedPeer(peerUserId: string): Promise<void> {
    await this.db.delete(VERIFIED_PEERS_STORE, peerUserId);
  }

  private async unseal(
    stored: StoredDevice,
    identity: string,
    unlockKey: CryptoKey,
  ): Promise<DeviceKeys> {
    if (stored.identity !== identity) {
      throw new Error('keystore holds a device for a different identity');
    }
    const keys = deserializeDeviceKeys(await openWithKey(unlockKey, stored.sealed, DEVICE_AAD));
    // Check the identity embedded in the decrypted KeyPackage, not just the caller-supplied metadata, so a
    // stored blob under this name can't silently hand back another identity's keys. This is a confusion
    // check, not full authenticity: proving a device is really `identity`'s is the key-directory +
    // fingerprint job (checkpoint 20, docs/threat-models/key-directory.md).
    if (deviceIdentity(keys) !== identity) {
      throw new Error('device identity does not match the requested identity');
    }
    return keys;
  }
}
