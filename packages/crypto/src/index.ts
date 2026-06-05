// The ONLY place MLS/crypto lives. A thin, typed wrapper over `ts-mls` (RFC 9420). No hand-rolled
// crypto. Private key material never leaves a Conversation/DeviceKeys object and is never logged or
// serialized for the server — only the opaque wire bytes from encrypt() ever leave the device.
import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
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

export {
  sealBackup,
  openBackup,
  DEFAULT_ARGON2,
  type SealedBackup,
  type Argon2Params,
} from './key-backup.js';
export { serializeDeviceKeys, deserializeDeviceKeys } from './device-codec.js';

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

/** What a new member needs to join. The server forwards these; both are opaque to it. */
export interface ConversationInvite {
  welcome: Welcome;
  ratchetTree: RatchetTree;
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
}
