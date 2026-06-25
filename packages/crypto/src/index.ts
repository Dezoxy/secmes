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
  type LeafIndex,
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
// `decryptSenderData` reads the sender leaf index from the SenderData blob inside a PrivateMessage.
// Not on the ts-mls barrel — subpath import, same pattern as the two above. The returned
// `SenderData.leafIndex` is authenticated: ts-mls messageProtection.js:120-123 verifies the
// FramedContent signature against the credential key at exactly that leaf, so a successful
// `processMessage` proves the holder of that leaf's key produced the content.
import { decryptSenderData } from 'ts-mls/privateMessage.js';

export {
  sealWithKey,
  openWithKey,
  importUnlockKey,
  encryptAttachment,
  decryptAttachment,
  type SealedBlob,
  type EncryptedAttachment,
} from './seal.js';
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

/**
 * Format a composite MLS device identity from a userId and a per-device UUID (CSPRNG, client-minted).
 * The string is stored as the BasicCredential identity bytes in the KeyPackage and sealed into the
 * device keystore. Two devices for the same user get distinct credential bytes, preventing identity
 * collision in multi-device group trees (B2).
 */
export function formatDeviceIdentity(userId: string, deviceUuid: string): string {
  return `${userId}:${deviceUuid}`;
}

/**
 * Parse a composite device identity back into its components. Returns `deviceUuid: undefined` for
 * pre-B2 keystores that stored only the raw userId — callers should treat that as a signal to
 * re-provision (clear + recreate) since the old identity byte sequence is no longer valid.
 */
export function parseDeviceIdentity(identity: string): {
  userId: string;
  deviceUuid: string | undefined;
} {
  const sep = identity.indexOf(':');
  if (sep === -1) return { userId: identity, deviceUuid: undefined };
  return { userId: identity.slice(0, sep), deviceUuid: identity.slice(sep + 1) };
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

// Shared fingerprint core: (domain || length-prefixed identity || signature public key).
// The 16-bit length prefix removes identity/key boundary ambiguity. `identityBytes` must be
// the raw credential bytes — callers are responsible for any encoding/re-encoding step.
async function deviceFingerprintRaw(
  identityBytes: Uint8Array,
  sigPub: Uint8Array,
): Promise<Uint8Array> {
  if (identityBytes.length > 0xffff)
    throw new Error('identity too long for the safety-number encoding');
  const idLen = new Uint8Array([(identityBytes.length >>> 8) & 0xff, identityBytes.length & 0xff]);
  return sha256(concatBytes(FP_DOMAIN, idLen, identityBytes, sigPub));
}

// Per-device fingerprint over a PUBLIC KeyPackage. The credential identity bytes are used directly
// (avoids any lossy UTF-8 round-trip from the raw wire format).
async function deviceFingerprint(pkg: KeyPackage): Promise<Uint8Array> {
  const cred = pkg.leafNode.credential;
  if (cred.credentialType !== 'basic') {
    throw new Error(`unsupported credential type: ${cred.credentialType}`);
  }
  return deviceFingerprintRaw(cred.identity, pkg.leafNode.signaturePublicKey);
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
 * Variant of {@link safetyNumber} for the group-roster path: takes {@link GroupMember} values
 * instead of KeyPackages. Used on the joiner side (and by the initiator post-confirm) where only
 * the joined MLS group's active-member roster is available — not the original directory KeyPackages.
 *
 * Produces the **same number** as `safetyNumber()` for the same underlying device, because both
 * reduce to `deviceFingerprintRaw(identityBytes, sigPub)`. `member.identity` is a string decoded
 * strict-UTF-8 by the MLS wrapper; re-encoding it via TextEncoder is lossless (guaranteed by the
 * strict decoder). The C2 cross-consistency test in `safety-number.spec.ts` covers this,
 * including a non-ASCII multi-byte identity, so any future decoder relaxation is caught immediately.
 */
export async function safetyNumberFromMember(
  local: GroupMember,
  remote: GroupMember,
): Promise<string> {
  const a = await deviceFingerprintRaw(te.encode(local.identity), local.signaturePublicKey);
  const b = await deviceFingerprintRaw(te.encode(remote.identity), remote.signaturePublicKey);
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return renderSafetyNumber(await sha256(concatBytes(first, second)));
}

/**
 * The full-width SAFETY NUMBER shown on D2 during device enrollment so D1 can verify D2's signing key
 * out-of-band before approving the link. Derived as `renderSafetyNumber(SHA-256(signaturePublicKey))` —
 * 8 groups of 5 digits (~133-bit), the SAME rendering as the two-party {@link safetyNumber}, but over a
 * single device's signature key (the only material the enrollment record carries to D1).
 *
 * Width is the security property (closes FP-1): at ~133 bits a malicious server cannot grind a second
 * Ed25519 key whose number collides with real D2's — the cost is ≥2^64, versus the ~10^9 (~30-bit) of the
 * old 9-digit code, which a server *could* grind to inject its own device. The artifact is COMPARED
 * visually across the two devices, never typed.
 *
 * Both D2 (computing from its own key) and D1 (computing from the server-stored fingerprint) must use
 * this function — matching algorithms is required for the numbers to agree; a key swap shifts the number.
 *
 * Accepts the key as a base64-standard string (what the key directory and enrollment API store).
 */
export async function enrollmentSafetyNumber(signaturePublicKeyB64: string): Promise<string> {
  const bin = atob(signaturePublicKeyB64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return renderSafetyNumber(await sha256(raw));
}

/**
 * The device's stable signing identity, WITHOUT the one-time KeyPackage HPKE private keys
 * (`initPrivateKey`/`hpkePrivateKey`). Restoring from this re-establishes the identity (mint fresh
 * KeyPackages, re-join groups) but cannot decrypt a previously-published Welcome — forward secrecy
 * is preserved. The full DeviceKeys are never uploaded.
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

/** One active member as seen from the local group roster. Used to resolve identities to leaf indices. */
export interface GroupMember {
  leafIndex: number;
  identity: string;
  signaturePublicKey: Uint8Array;
}

/**
 * Return type of {@link Conversation.decryptAuthenticated}. The sender is proven by the MLS group
 * signature: `senderLeafIndex` is the leaf ts-mls verified the FramedContent signature against
 * (messageProtection.js:120-123), so the holder of that leaf's credential key is the authenticated
 * sender — not merely asserted.
 *
 * ⚠️ Scope: proves *intra-group* sender authenticity ("signed by the holder of leaf N's key").
 * Whether leaf N belongs to the expected real-world user is the key-directory + out-of-band
 * fingerprint job (`docs/threat-models/key-directory.md`).
 */
export interface AuthenticatedMessage {
  plaintext: string;
  senderLeafIndex: number;
  senderIdentity: string;
}

/**
 * A commit created by {@link Conversation.stageMembershipCommit} but NOT yet applied.
 * Holds the post-commit ClientState privately so the caller can: (a) seal and persist it before
 * POSTing, (b) promote it on server 200, or (c) wipe it on a 409 epoch-race and rebase.
 *
 * The `_pendingState` and `_consumed` fields are internal — only pass a StagedCommit back
 * to `applyStaged`/`discardStaged`/`serializeStaged` on the same Conversation.
 */
export class StagedCommit {
  readonly commit: Uint8Array;
  readonly invite: ConversationInvite | undefined;
  readonly epoch: number;
  /** @internal */
  readonly _pendingState: ClientState;
  /** @internal: spent ratchet secrets; wiped on discardStaged */
  readonly _consumed: Uint8Array[];

  constructor(
    commit: Uint8Array,
    invite: ConversationInvite | undefined,
    epoch: number,
    pendingState: ClientState,
    consumed: Uint8Array[],
  ) {
    this.commit = commit;
    this.invite = invite;
    this.epoch = epoch;
    this._pendingState = pendingState;
    this._consumed = consumed;
  }
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
   * Strip a device to its identity-only material: the signing identity, minus the one-time KeyPackage
   * HPKE private keys. Export THIS — not the full DeviceKeys — so a leaked export can't decrypt a
   * retained Welcome (forward secrecy).
   */
  exportIdentity(keys: DeviceKeys): DeviceIdentity {
    return {
      identity: deviceIdentity(keys),
      signaturePublicKey: keys.publicPackage.leafNode.signaturePublicKey,
      signaturePrivateKey: keys.privatePackage.signaturePrivateKey,
    };
  }

  /**
   * Re-establish a full device from identity-only material by minting a FRESH KeyPackage under the same
   * signature identity. The new device gets new one-time HPKE keys — so it cannot read a pre-existing
   * Welcome — and must re-publish + re-join groups.
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
   * Reconstruct a Conversation from `Conversation.serialize()` bytes (after `openWithKey` unseals them) — the
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
   * (signature private + path/ratchet secrets) — seal them immediately (`sealWithKey`); never persist or
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

  /**
   * Enumerate active group members from the local ratchet tree: leaf index, stable identity string,
   * and signature public key. Used to resolve a user's devices to leaf indices before a remove commit.
   * Synchronous — reads current state without advancing the ratchet.
   */
  members(): GroupMember[] {
    const result: GroupMember[] = [];
    // The ratchet tree is a flat array: node at index i is a leaf iff i % 2 === 0, with leafIndex = i / 2.
    for (let nodeIdx = 0; nodeIdx < this.state.ratchetTree.length; nodeIdx++) {
      if (nodeIdx % 2 !== 0) continue; // parent node slot
      const node = this.state.ratchetTree[nodeIdx];
      if (!node || node.nodeType !== 'leaf') continue; // blank leaf
      const cred = node.leaf.credential;
      if (cred.credentialType !== 'basic') continue; // v1 issues Basic only
      result.push({
        leafIndex: nodeIdx / 2,
        identity: tdStrict.decode(cred.identity),
        signaturePublicKey: node.leaf.signaturePublicKey,
      });
    }
    return result;
  }

  /**
   * Stage a membership commit (add and/or remove) WITHOUT advancing local state.
   *
   * Returns a {@link StagedCommit} holding: the encrypted commit wire bytes to fan out to the server,
   * an optional invite (present iff there are adds), the epoch at which the commit was created (the
   * server's slot key), and the pending post-commit state.
   *
   * The caller must:
   *  1. Seal `serializeStaged(staged)` → persist to the pending keystore slot (before POSTing).
   *  2. POST the commit. On 200: call `applyStaged` then persist the live state.
   *     On 409: call `discardStaged` and re-stage from the new epoch (up to N retries).
   *
   * ⚠️ Identity binding: same requirement as `addMember` — the caller MUST verify each added
   * KeyPackage out-of-band (safety number) before calling. See fingerprint-verification.md.
   */
  async stageMembershipCommit(opts: {
    add?: KeyPackage[];
    removeLeafIndices?: number[];
  }): Promise<StagedCommit> {
    return this.run(async () => {
      const proposals: Array<
        | { proposalType: 'add'; add: { keyPackage: KeyPackage } }
        | { proposalType: 'remove'; remove: { removed: LeafIndex } }
      > = [];
      for (const kp of opts.add ?? []) {
        proposals.push({ proposalType: 'add', add: { keyPackage: kp } });
      }
      for (const li of opts.removeLeafIndices ?? []) {
        proposals.push({ proposalType: 'remove', remove: { removed: li as LeafIndex } });
      }
      const epochAtCreation = this.epoch; // snapshot BEFORE the commit advances the epoch

      // Deep-clone via encode→decode round-trip so createCommit's `consumed` array holds
      // references to clone buffers, not live-state buffers. Without this, discardStaged()
      // would zero this.state.keySchedule.initSecret (same reference) and break any
      // subsequent processCommit or stageMembershipCommit on this Conversation.
      const stateSnapshot = encodeGroupState(this.state);
      const decodedClone = decodeGroupState(stateSnapshot, 0);
      if (!decodedClone) throw new Error('could not clone state for staging');
      const stateForCommit: ClientState = {
        ...decodedClone[0],
        clientConfig: this.state.clientConfig,
      };

      const result = await createCommit(
        { state: stateForCommit, cipherSuite: this.cs },
        { extraProposals: proposals },
      );
      // DON'T advance this.state — the current state must remain valid for a 409 rebase.
      const wire = encodeMlsMessage(result.commit);
      const invite = result.welcome
        ? { welcome: result.welcome, ratchetTree: result.newState.ratchetTree }
        : undefined;
      return new StagedCommit(wire, invite, epochAtCreation, result.newState, result.consumed);
    });
  }

  /**
   * Serialize the pending post-commit state from a staged commit for sealed persistence (the
   * "pending keystore slot"). The returned bytes carry SECRET key material — seal immediately
   * with `sealWithKey`; never persist or transmit them raw. Inverse: `MlsEngine.deserializeConversation`.
   */
  serializeStaged(staged: StagedCommit): Uint8Array {
    return encodeGroupState(staged._pendingState);
  }

  /**
   * Promote a staged commit after the server returns 200 (epoch slot won). Advances this conversation
   * to the pending post-commit state. Must be followed immediately by `persistVia` to seal the new state.
   * Runs inside the op queue so it orders correctly with concurrent encrypt/decrypt.
   */
  async applyStaged(staged: StagedCommit): Promise<void> {
    return this.run(async () => {
      this.state = staged._pendingState;
    });
  }

  /**
   * Wipe a staged commit after a 409 epoch-race loss. Zeroes the spent ratchet secrets from the
   * abandoned commit so they don't linger in memory. Does NOT touch `this.state` (still at the
   * pre-commit epoch, ready for a rebase).
   */
  discardStaged(staged: StagedCommit): void {
    wipe(staged._consumed);
  }

  /**
   * Process an incoming commit frame (from another group member). Advances this conversation's
   * epoch and updates the ratchet state. Must be called for every commit at the current epoch
   * before decrypting any application messages at the next epoch.
   *
   * Strict: throws if the wire frame is not an application message (`mls_private_message`) or if
   * the result is not a handshake/commit (`kind !== 'newState'`). Wrong-kind frames are dropped
   * without advancing state (see threat model §T3). Persists after every successful commit via the
   * provided `persister`; wires `persistVia` discipline (sealed snapshot inside the op queue).
   */
  async processCommit(
    wire: Uint8Array,
    persister: (snapshot: Uint8Array) => Promise<void>,
  ): Promise<void> {
    return this.run(async () => {
      const decoded = decodeMlsMessage(wire, 0);
      if (!decoded) throw new Error('could not decode MLS commit');
      const [msg, bytesRead] = decoded;
      if (bytesRead !== wire.length) throw new Error('trailing bytes after MLS message');
      if (msg.wireformat !== 'mls_private_message') {
        throw new Error(`expected mls_private_message commit, got "${msg.wireformat}"`);
      }
      const result = await processMessage(msg, this.state, emptyPskIndex, acceptAll, this.cs);
      wipe(result.consumed);
      if (result.kind !== 'newState') {
        // Application message posted to the commit endpoint — noise, don't advance state.
        throw new Error(`expected commit (newState), got "${result.kind}"`);
      }
      this.state = result.newState;
      await persister(encodeGroupState(this.state));
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

  /**
   * Shared decrypt core — called from within `this.run(...)`, never directly.
   * Runs `processMessage` and `decryptSenderData` in parallel: both read the current state
   * snapshot without modifying it. The `senderDataSecret` is epoch-stable across application
   * messages (an application message never advances the epoch), so capturing it once before the
   * parallel calls is safe and sufficient.
   */
  private async decryptInner(
    wire: Uint8Array,
  ): Promise<{ plaintext: string; senderLeafIndex: number }> {
    const decoded = decodeMlsMessage(wire, 0);
    if (!decoded) throw new Error('could not decode MLS message');
    const [msg, bytesRead] = decoded;
    // Strict: reject anything appended after the MLS message (transport-framing bug or a malicious
    // client smuggling non-MLS — including accidental plaintext — alongside the ciphertext).
    if (bytesRead !== wire.length) throw new Error('trailing bytes after MLS message');
    if (msg.wireformat !== 'mls_private_message') {
      throw new Error(`expected an application message, got "${msg.wireformat}"`);
    }
    // Capture before the parallel calls; senderDataSecret does not appear in result.consumed.
    const senderDataSecret = this.state.keySchedule.senderDataSecret;
    const [result, senderData] = await Promise.all([
      processMessage(msg, this.state, emptyPskIndex, acceptAll, this.cs),
      // SECURITY: decryptSenderData returns the leaf that ts-mls messageProtection.js:120-123
      // verifies the FramedContent signature against — the two calls agree on the signer because
      // they both decrypt the same SenderData AEAD blob (same epoch secret, same ciphertext).
      // An adversary cannot forge a different leafIndex without breaking the AEAD MAC.
      decryptSenderData(msg.privateMessage, senderDataSecret, this.cs),
    ]);
    wipe(result.consumed); // spent ratchet secrets — unconditional, regardless of message kind
    if (result.kind !== 'applicationMessage') {
      // Do NOT advance state for a message this method doesn't handle (e.g. a handshake/commit).
      // Application messages only; handshake processing is a separate path for group chat / PCS
      // self-updates (see docs/threat-models/mls-integration.md §5–6).
      throw new Error(`expected applicationMessage, got "${result.kind}"`);
    }
    // F6: decryptSenderData returns undefined when the SenderData AEAD MAC fails (wrong epoch
    // secret or tampered blob). Fail-closed: never return a result without a verified sender.
    if (senderData === undefined) {
      throw new Error('SenderData authentication failed — cannot verify sender identity');
    }
    this.state = result.newState;
    return { plaintext: td.decode(result.message), senderLeafIndex: senderData.leafIndex };
  }

  /** Decrypt wire bytes → plaintext. Throws on anything that isn't an application message. */
  async decrypt(wire: Uint8Array): Promise<string> {
    return this.run(async () => (await this.decryptInner(wire)).plaintext);
  }

  /**
   * Decrypt wire bytes and authenticate the sender against the current group roster.
   *
   * Returns the plaintext together with the sender's MLS leaf index and identity string. The sender
   * is authenticated by the MLS group signature: the leaf index is the one ts-mls verified the
   * FramedContent signature against (messageProtection.js:120-123), not merely asserted by the
   * sender. Used by the call-signaling path (P1-SIG) so SDP/ICE is only accepted from the
   * authenticated conversation peer.
   *
   * Fail-closed: every failure path throws — no partial results, no silent downgrades:
   *   F1 malformed wire / trailing bytes, F2 wrong wire format, F3 wrong message kind,
   *   F4 invalid MLS signature (propagated from processMessage, incl. SenderData-leaf≠signed-leaf),
   *   F6 SenderData MAC failure, F7 sender leaf not a current group member,
   *   F8 non-Basic credential type, F9 malformed UTF-8 in credential identity.
   */
  async decryptAuthenticated(wire: Uint8Array): Promise<AuthenticatedMessage> {
    return this.run(async () => {
      const { plaintext, senderLeafIndex } = await this.decryptInner(wire);
      // Resolve leafIndex → identity in the current roster (same critical section, post-advance
      // state). Application messages never change the epoch or ratchet tree (membership), so the
      // roster is the same before and after the state advance in decryptInner.
      let senderIdentity: string | undefined;
      for (let nodeIdx = 0; nodeIdx < this.state.ratchetTree.length; nodeIdx++) {
        if (nodeIdx % 2 !== 0) continue; // parent node slot
        const node = this.state.ratchetTree[nodeIdx];
        if (!node || node.nodeType !== 'leaf') continue; // blank leaf
        if (nodeIdx / 2 !== senderLeafIndex) continue;
        const cred = node.leaf.credential;
        // F8: non-Basic credential — v1 issues Basic only; anything else is unexpected.
        if (cred.credentialType !== 'basic') {
          throw new Error(
            `sender leaf ${senderLeafIndex} has unsupported credential type: ${cred.credentialType}`,
          );
        }
        // F9: tdStrict throws on malformed UTF-8 rather than replacing → U+FFFD; prevents two
        // distinct byte strings from colliding after a lossy decode in an identity equality check.
        senderIdentity = tdStrict.decode(cred.identity);
        break;
      }
      // F7: leaf not found in the current roster — reject; never accept an unauthenticated sender.
      if (senderIdentity === undefined) {
        throw new Error(`sender leaf ${senderLeafIndex} is not a current group member`);
      }
      return { plaintext, senderLeafIndex, senderIdentity };
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
