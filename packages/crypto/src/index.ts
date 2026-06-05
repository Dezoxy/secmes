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

// Classic suite for v1 (single-device). Post-quantum (X-Wing) is available in ts-mls and a later option.
export const CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

const te = new TextEncoder();
const td = new TextDecoder();

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
  constructor(
    private readonly cs: CiphersuiteImpl,
    private state: ClientState,
  ) {}

  /**
   * Add a member by their published KeyPackage; returns the invite to forward to them.
   *
   * 2-PARTY SCOPE: the adder is the only existing member, so it applies the commit locally (the
   * returned `newState`) while the new member joins via the Welcome. Group chat (3+ members) and PCS
   * self-updates additionally require fanning out `commit.commit` to existing members + a
   * handshake-processing path to apply it — deferred with group chat (backlog B1). See
   * docs/threat-models/mls-integration.md §5–6.
   */
  async addMember(memberPublicPackage: KeyPackage): Promise<ConversationInvite> {
    const commit = await createCommit(
      { state: this.state, cipherSuite: this.cs },
      { extraProposals: [{ proposalType: 'add', add: { keyPackage: memberPublicPackage } }] },
    );
    this.state = commit.newState;
    if (!commit.welcome) throw new Error('add did not produce a Welcome');
    return { welcome: commit.welcome, ratchetTree: this.state.ratchetTree };
  }

  /** Encrypt plaintext → opaque wire bytes (the only thing that leaves the device). */
  async encrypt(plaintext: string): Promise<Uint8Array> {
    const made = await createApplicationMessage(this.state, te.encode(plaintext), this.cs);
    this.state = made.newState;
    return encodeMlsMessage({
      wireformat: 'mls_private_message',
      version: 'mls10',
      privateMessage: made.privateMessage,
    });
  }

  /** Decrypt wire bytes → plaintext. Throws on anything that isn't an application message. */
  async decrypt(wire: Uint8Array): Promise<string> {
    const decoded = decodeMlsMessage(wire, 0);
    if (!decoded) throw new Error('could not decode MLS message');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_private_message') {
      throw new Error(`expected an application message, got "${msg.wireformat}"`);
    }
    const result = await processMessage(msg, this.state, emptyPskIndex, acceptAll, this.cs);
    if (result.kind !== 'applicationMessage') {
      // Do NOT advance state for a message this method doesn't handle (e.g. a handshake/commit).
      // decrypt() handles application messages only; handshake processing is a separate path
      // required before group chat / PCS self-updates (see threat model §5–6).
      throw new Error(`expected applicationMessage, got "${result.kind}"`);
    }
    this.state = result.newState; // commit state only after we know this was an application message
    return td.decode(result.message);
  }
}
