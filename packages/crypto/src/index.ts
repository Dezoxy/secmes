// The ONLY place MLS/crypto lives. A thin, typed wrapper over `ts-mls` (RFC 9420). No hand-rolled
// crypto. Private key material never leaves a Conversation/DeviceKeys object and is never logged or
// serialized for the server — only the opaque wire bytes from encrypt() ever leave the device.
import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  type CiphersuiteImpl,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
  type RatchetTree,
  type Welcome,
} from 'ts-mls';
// `makeKeyPackageRef` isn't on the ts-mls barrel (types only) — reach it via the package subpath, the same
// pattern as `@argus/crypto/device-proof`. Used to match a Welcome to the retained private it was sealed to.
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
// `defaultClientConfig` is a value (not on the barrel — only `type ClientConfig` is). `encodeGroupState`
// drops `clientConfig` (behaviour/functions, no key material); we re-attach the default on deserialize, the
// same config `createGroup`/`joinGroup` use.
import { defaultClientConfig } from 'ts-mls/clientConfig.js';

export {
  sealBackup,
  openBackup,
  deriveSessionKey,
  sealWithKey,
  openWithKey,
  DEFAULT_ARGON2,
  type SealedBackup,
  type SealedBlob,
  type Argon2Params,
} from './key-backup.js';
export {
  serializeDeviceKeys,
  deserializeDeviceKeys,
  serializeDeviceKeysArray,
  deserializeDeviceKeysArray,
  serializeDeviceIdentity,
  deserializeDeviceIdentity,
  serializeKeyPackage,
  deserializeKeyPackage,
  deviceSignaturePublicKeyB64,
  deviceSignatureSeed,
  serializeInvite,
  deserializeInvite,
  type SerializedInvite,
} from './device-codec.js';
// A peer's PUBLIC key material (what the key directory publishes) — the input to `safetyNumber`.
export type { KeyPackage } from 'ts-mls';

// Classic suite for v1 (single-device). Post-quantum (X-Wing) is available in ts-mls and a later option.
export const CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Best-effort overwrite of spent ratchet secrets (the `consumed` arrays ts-mls returns) for forward
 * secrecy. JS can't guarantee the engine kept no internal copies, but this zeroes the buffers we hold.
 */
function wipe(buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

/** A device's MLS key material: `publicPackage` is published to the key directory; `privatePackage` stays local. */
export interface DeviceKeys {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

// Strict decode for the identity field: reject malformed UTF-8 rather than coerce it to U+FFFD, so two
// distinct identity byte strings can't collide after a lossy decode in an equality check.
const tdStrict = new TextDecoder('utf-8', { fatal: true });

/**
 * The device identity carried in a DeviceKeys' KeyPackage Basic credential. Callers restoring a sealed
 * backup compare this to the expected identity to catch a recovery service handing back the wrong
 * (genuine) blob under another name. NOTE: this reads the field; it does not by itself prove
 * authenticity against an adversary who can mint a self-signed KeyPackage for an arbitrary name —
 * cross-device identity authenticity is the key-directory + out-of-band fingerprint job (checkpoint 20,
 * see docs/threat-models/key-directory.md). Throws on a non-Basic credential (v1 issues Basic only) or
 * malformed identity bytes.
 */
export function deviceIdentity(keys: DeviceKeys): string {
  const cred = keys.publicPackage.leafNode.credential;
  if (cred.credentialType !== 'basic') {
    throw new Error(`unsupported credential type: ${cred.credentialType}`);
  }
  return tdStrict.decode(cred.identity);
}

// ---- Out-of-band fingerprint / safety number (checkpoint 20) ------------------------------------
// A short, comparable number derived from two devices' STABLE identity (signature) public keys.
// Compared out-of-band, a mismatch reveals a MITM key-swap during member-add (which MLS `addMember`
// does NOT detect). Public keys only — nothing is sent to the server. See fingerprint-verification.md.

const FP_DOMAIN = te.encode('argus-fp:v1');

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

// Per-device fingerprint over (domain || length-prefixed identity || signature public key), all read
// from a PUBLIC KeyPackage (the peer's published material) — no private key needed. The signature key
// is the device's stable identity; the length prefix removes identity/key boundary ambiguity.
async function deviceFingerprint(pkg: KeyPackage): Promise<Uint8Array> {
  const cred = pkg.leafNode.credential;
  if (cred.credentialType !== 'basic') {
    throw new Error(`unsupported credential type: ${cred.credentialType}`);
  }
  const identity = cred.identity; // raw identity bytes (avoids any lossy UTF-8 round-trip)
  // The 16-bit length prefix is what removes identity/key boundary ambiguity; enforce its bound so a
  // future longer identity can't silently wrap it and reintroduce the ambiguity.
  if (identity.length > 0xffff) throw new Error('identity too long for the safety-number encoding');
  const sigPub = pkg.leafNode.signaturePublicKey;
  const idLen = new Uint8Array([(identity.length >>> 8) & 0xff, identity.length & 0xff]);
  return sha256(concatBytes(FP_DOMAIN, idLen, identity, sigPub));
}

/** Render a 32-byte digest as 8 space-separated groups of 5 decimal digits (read-aloud friendly). */
function renderSafetyNumber(digest: Uint8Array): string {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push((view.getUint32(i * 4) % 100000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

/**
 * The two-party SAFETY NUMBER both peers compare out-of-band (checkpoint 20). Takes the two devices'
 * published **KeyPackages** (PUBLIC material only — for a remote peer this is exactly what the key
 * directory hands you before `addMember`, so no private key is needed). Derived from the identity
 * (signature) public keys + identities — **symmetric** (sorted, so both sides get the same string) and
 * **deterministic**. A mismatch means a key was swapped (MITM). Stable across KeyPackage re-mints (the
 * signature identity is preserved); changes only if an identity key changes.
 */
export async function safetyNumber(local: KeyPackage, remote: KeyPackage): Promise<string> {
  const a = await deviceFingerprint(local);
  const b = await deviceFingerprint(remote);
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return renderSafetyNumber(await sha256(concatBytes(first, second)));
}

/**
 * Identity-only recovery material: the device's stable signing identity, WITHOUT the one-time KeyPackage
 * HPKE private keys (`initPrivateKey`/`hpkePrivateKey`). This is all a cross-device backup may carry
 * (key-backup.md §4): restoring it re-establishes the identity (mint fresh KeyPackages, re-join groups),
 * but it cannot decrypt a previously-published Welcome, so a leaked backup can't recover history —
 * forward secrecy is preserved. The full DeviceKeys are never uploaded.
 */
export interface DeviceIdentity {
  identity: string;
  signaturePublicKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
}

/** What a new member needs to join. The server forwards these; both are opaque to it. */
export interface ConversationInvite {
  welcome: Welcome;
  ratchetTree: RatchetTree;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Thrown by {@link MlsEngine.joinConversationFromPool} when no retained KeyPackage matches the Welcome. */
export class NoMatchingPoolMember extends Error {
  constructor() {
    super('no retained KeyPackage matches this Welcome');
    this.name = 'NoMatchingPoolMember';
  }
}

/** Stateless holder of the ciphersuite primitives. Create once, reuse. */
export class MlsEngine {
  private constructor(private readonly cs: CiphersuiteImpl) {}

  static async create(): Promise<MlsEngine> {
    return new MlsEngine(await getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE)));
  }

  /** Generate a device's key material. `identity` is a stable device/user identifier (not a secret). */
  async generateDeviceKeys(identity: string): Promise<DeviceKeys> {
    // Advertise ONLY the pinned suite (defaultCapabilities() lists all 21) so a peer can't pick a
    // weaker suite when it creates a group and adds us — downgrade resistance for our KeyPackage.
    const capabilities = { ...defaultCapabilities(), ciphersuites: [CIPHERSUITE] };
    return generateKeyPackage(
      { credentialType: 'basic', identity: te.encode(identity) },
      capabilities,
      defaultLifetime,
      [],
      this.cs,
    );
  }

  /**
   * Strip a device to its identity-only recovery material (key-backup.md §4): the signing identity,
   * minus the one-time KeyPackage HPKE private keys. Seal THIS — not the full DeviceKeys — for backup so
   * a leaked backup can't decrypt a retained Welcome (forward secrecy).
   */
  exportIdentity(keys: DeviceKeys): DeviceIdentity {
    return {
      identity: deviceIdentity(keys),
      signaturePublicKey: keys.publicPackage.leafNode.signaturePublicKey,
      signaturePrivateKey: keys.privatePackage.signaturePrivateKey,
    };
  }

  /**
   * Re-establish a full device from identity-only recovery material by minting a FRESH KeyPackage under
   * the same signature identity. The new device gets new one-time HPKE keys — so it cannot read a
   * pre-existing Welcome — and must re-publish + re-join groups. The forward-secret recovery path of
   * key-backup.md §4.
   */
  async deviceFromIdentity(id: DeviceIdentity): Promise<DeviceKeys> {
    const capabilities = { ...defaultCapabilities(), ciphersuites: [CIPHERSUITE] };
    const keys = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: te.encode(id.identity) },
      capabilities,
      defaultLifetime,
      [],
      { signKey: id.signaturePrivateKey, publicKey: id.signaturePublicKey },
      this.cs,
    );
    // Defense-in-depth: the freshly-minted credential must carry the identity we restored.
    if (deviceIdentity(keys) !== id.identity) {
      throw new Error('minted device identity does not match the recovery material');
    }
    return keys;
  }

  /**
   * Mint a FRESH one-time KeyPackage under `device`'s stable signature identity: same Ed25519 signature
   * key (→ same fingerprint / safety number) but a fresh HPKE init key (→ genuinely one-time). Use to
   * fill the device's published KeyPackage pool (key directory #19). The returned DeviceKeys' PRIVATE must
   * be RETAINED until the Welcome sealed to this KeyPackage is joined, and never reused across joins
   * (forward secrecy). Reuses the recovery mint path (`exportIdentity` → `deviceFromIdentity`).
   */
  async mintKeyPackage(device: DeviceKeys): Promise<DeviceKeys> {
    return this.deviceFromIdentity(this.exportIdentity(device));
  }

  /** Start a new conversation (MLS group) owned by `keys`. */
  async createConversation(conversationId: string, keys: DeviceKeys): Promise<Conversation> {
    const state = await createGroup(
      te.encode(conversationId),
      keys.publicPackage,
      keys.privatePackage,
      [],
      this.cs,
    );
    return new Conversation(this.cs, state);
  }

  /** Join a conversation from a Welcome produced by an existing member. */
  async joinConversation(keys: DeviceKeys, invite: ConversationInvite): Promise<Conversation> {
    const state = await joinGroup(
      invite.welcome,
      keys.publicPackage,
      keys.privatePackage,
      emptyPskIndex,
      this.cs,
      invite.ratchetTree,
    );
    return new Conversation(this.cs, state);
  }

  /**
   * The MLS `key_package_ref` for a device's KeyPackage — the value a Welcome carries in
   * `secrets[].newMember` to address the recipient. Used to match a Welcome to the retained private it was
   * sealed to. Derived from PUBLIC material only.
   */
  async keyPackageRef(keys: DeviceKeys): Promise<Uint8Array> {
    return makeKeyPackageRef(keys.publicPackage, this.cs.hash);
  }

  /**
   * Join from a Welcome by selecting the ONE retained pool member it was HPKE-sealed to. A Welcome targets
   * a single one-time KeyPackage; `joinConversation` needs exactly that member's private. Match each
   * retained member's `key_package_ref` against the Welcome's `secrets[].newMember` and join with the hit.
   * Returns the joined conversation AND the matched member so the caller can prune it — a consumed one-time
   * private must never be reused (forward secrecy). Throws {@link NoMatchingPoolMember} if none fits (e.g.
   * the Welcome targets a KeyPackage whose private was already discarded — a stranded package), so the
   * caller can skip that Welcome without aborting the rest. Comparing one's OWN public refs, so plain
   * byte-equality is fine (no secret comparison → no timing concern).
   */
  async joinConversationFromPool(
    pool: DeviceKeys[],
    invite: ConversationInvite,
  ): Promise<{ conversation: Conversation; member: DeviceKeys }> {
    const wanted = invite.welcome.secrets.map((s) => s.newMember);
    for (const member of pool) {
      const ref = await this.keyPackageRef(member);
      if (wanted.some((w) => bytesEqual(w, ref))) {
        return { conversation: await this.joinConversation(member, invite), member };
      }
    }
    throw new NoMatchingPoolMember();
  }

  /**
   * Reconstruct a Conversation from `Conversation.serialize()` bytes (after `openBackup` unseals them) — the
   * rehydrate path so a group survives a reload. `encodeGroupState` drops the behaviour-only `clientConfig`
   * (no key material), so re-attach the default — the config `createGroup`/`joinGroup` use. Throws on
   * malformed bytes.
   */
  deserializeConversation(bytes: Uint8Array): Conversation {
    const decoded = decodeGroupState(bytes, 0);
    if (!decoded) throw new Error('malformed group state');
    const state: ClientState = { ...decoded[0], clientConfig: defaultClientConfig };
    return new Conversation(this.cs, state);
  }
}

/** One device's view of one conversation. State evolves with each op; it is never logged or sent. */
export class Conversation {
  // Serializes stateful ops so each observes the previous op's state. Without this, two concurrent
  // encrypt()/decrypt() calls would read the same ratchet generation → AEAD nonce/key reuse.
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cs: CiphersuiteImpl,
    private state: ClientState,
  ) {}

  /** Run `op` after all prior ops on this conversation have settled (per-conversation mutex). */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.opQueue.then(op, op); // proceed whether the previous op resolved or rejected
    this.opQueue = result.then(
      () => undefined,
      () => undefined,
    ); // a failed op must not poison the chain
    return result;
  }

  /**
   * Serialize this conversation's MLS group state to bytes — for SEALED durable storage. The ratchet
   * advances on every encrypt/decrypt, so the state must survive a reload or the group desyncs. Runs in the
   * op queue so it observes a consistent post-op snapshot. ⚠️ The bytes carry live SECRET key material
   * (signature private + path/ratchet secrets) — seal them immediately (`sealBackup`); never persist or
   * transmit them raw. Inverse: `MlsEngine.deserializeConversation`.
   */
  async serialize(): Promise<Uint8Array> {
    return this.run(async () => encodeGroupState(this.state));
  }

  /**
   * Persist a consistent snapshot via `persister`, run INSIDE the op mutex — so the snapshot AND the
   * persister's seal + write are ordered with every ratchet op. Two close persists can't reorder: a later
   * op's snapshot is never overwritten by an earlier one (no rollback → no MLS desync / sending-generation
   * reuse). The snapshot carries live SECRET key material; the persister must seal it immediately. (Doing
   * the seal/write OUTSIDE this mutex — e.g. `await conv.serialize()` then seal — is the racy anti-pattern.)
   */
  async persistVia(persister: (snapshot: Uint8Array) => Promise<void>): Promise<void> {
    return this.run(() => persister(encodeGroupState(this.state)));
  }

  /**
   * Add a member by their published KeyPackage; returns the invite to forward to them.
   *
   * ⚠️ IDENTITY BINDING: this wrapper does NOT verify that `memberPublicPackage` belongs to the
   * intended peer — ts-mls' default `validateCredential` accepts any Basic credential. A malicious
   * server that mediates KeyPackage exchange could substitute keys (MITM). The caller MUST verify the
   * KeyPackage out-of-band (fingerprint) per docs/threat-models/key-directory.md. Not reachable at
   * checkpoint 17 (no key directory yet); MUST-WIRE before checkpoint 19 mediates KeyPackage exchange.
   *
   * 2-PARTY SCOPE: the adder is the only existing member, so it applies the commit locally (the
   * returned `newState`) while the new member joins via the Welcome. Group chat (3+ members) and PCS
   * self-updates additionally require fanning out `commit.commit` to existing members + a
   * handshake-processing path to apply it — deferred with group chat (backlog B1). See
   * docs/threat-models/mls-integration.md §5–6.
   */
  async addMember(memberPublicPackage: KeyPackage): Promise<ConversationInvite> {
    return this.run(async () => {
      const commit = await createCommit(
        { state: this.state, cipherSuite: this.cs },
        { extraProposals: [{ proposalType: 'add', add: { keyPackage: memberPublicPackage } }] },
      );
      this.state = commit.newState;
      wipe(commit.consumed);
      if (!commit.welcome) throw new Error('add did not produce a Welcome');
      return { welcome: commit.welcome, ratchetTree: this.state.ratchetTree };
    });
  }

  /** Encrypt plaintext → opaque wire bytes (the only thing that leaves the device). */
  async encrypt(plaintext: string): Promise<Uint8Array> {
    return this.run(async () => {
      const made = await createApplicationMessage(this.state, te.encode(plaintext), this.cs);
      this.state = made.newState;
      const wire = encodeMlsMessage({
        wireformat: 'mls_private_message',
        version: 'mls10',
        privateMessage: made.privateMessage,
      });
      wipe(made.consumed);
      return wire;
    });
  }

  /** Decrypt wire bytes → plaintext. Throws on anything that isn't an application message. */
  async decrypt(wire: Uint8Array): Promise<string> {
    return this.run(async () => {
      const decoded = decodeMlsMessage(wire, 0);
      if (!decoded) throw new Error('could not decode MLS message');
      const [msg, bytesRead] = decoded;
      // Strict: reject anything appended after the MLS message (transport-framing bug or a malicious
      // client smuggling non-MLS — including accidental plaintext — alongside the ciphertext).
      if (bytesRead !== wire.length) throw new Error('trailing bytes after MLS message');
      if (msg.wireformat !== 'mls_private_message') {
        throw new Error(`expected an application message, got "${msg.wireformat}"`);
      }
      const result = await processMessage(msg, this.state, emptyPskIndex, acceptAll, this.cs);
      wipe(result.consumed); // spent secrets — wipe regardless of message kind
      if (result.kind !== 'applicationMessage') {
        // Do NOT advance state for a message this method doesn't handle (e.g. a handshake/commit).
        // decrypt() handles application messages only; handshake processing is a separate path
        // required before group chat / PCS self-updates (see threat model §5–6).
        throw new Error(`expected applicationMessage, got "${result.kind}"`);
      }
      this.state = result.newState; // commit state only after we confirm an application message
      return td.decode(result.message);
    });
  }

  /**
   * The current MLS epoch — non-secret group metadata the server stores alongside the ciphertext (for
   * ordering/observability; the server stays crypto-blind). v1 1:1 is single-epoch, so this stays small.
   * Narrowed from the underlying bigint; fails LOUD past 2^53 rather than silently losing precision (a
   * deferred group-chat/PCS path could advance the epoch far — better to throw than emit wrong metadata).
   */
  get epoch(): number {
    const epoch = this.state.groupContext.epoch;
    if (epoch > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('MLS epoch exceeds safe integer range');
    return Number(epoch);
  }
}
